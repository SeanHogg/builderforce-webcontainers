import { describe, expect, it } from 'vitest';
import { createKnowledgeMemory } from '../src/memoryIntegration/knowledgeMemory.js';
import { createMemoryKnowledgePersistence } from '../src/memoryIntegration/persistence.js';
import type { TextEmbedder } from '../src/memoryIntegration/types.js';
import { chunkText, tokenize } from '../src/memoryIntegration/text.js';

/** Deterministic hashed bag-of-words embedder (same scheme as memory-integration.test.ts). */
function fakeEmbedder(dims = 64): TextEmbedder & { calls: string[] } {
  const calls: string[] = [];
  return {
    dimensions: dims,
    fingerprint: `fake/${dims}`,
    calls,
    async embed(text: string) {
      calls.push(text);
      const v = new Float32Array(dims);
      for (const t of tokenize(text)) {
        let h = 2166136261;
        for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
        v[(h >>> 0) % dims]! += 1;
      }
      return v;
    },
  };
}

describe('createKnowledgeMemory (knowledgeMemory.ts)', () => {
  it('preserves citation offsets when overlapping chunks hard-split a word', () => {
    const chunks = chunkText('abcdefghijklmnop', { chunkSize: 6, chunkOverlap: 2 });

    expect(chunks.map((chunk) => [chunk.text, chunk.start])).toEqual([
      ['abcdef', 0],
      ['efghij', 4],
      ['ijkl', 8],
      ['klmnop', 10],
    ]);
  });

  it('ingests, retrieves and reports stats', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    const r = await mem.ingest({ id: 'd1', text: 'the quick brown fox jumps over the lazy dog', title: 'Fox' });
    expect(r.status).toBe('added');
    expect(r.version).toBe(1);
    expect(r.chunks).toBeGreaterThan(0);
    expect(mem.stats().documents).toBe(1);
    const hits = await mem.retrieve('quick fox', { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.source.sourceId).toBe('d1');
    expect(hits[0]!.source.title).toBe('Fox');
  });

  it('is a no-op re-ingest when content and metadata are unchanged', async () => {
    const emb = fakeEmbedder();
    const mem = createKnowledgeMemory({ embedder: emb });
    await mem.ingest({ id: 'd1', text: 'some stable content', metadata: { team: 'a' } });
    emb.calls.length = 0;
    const again = await mem.ingest({ id: 'd1', text: 'some stable content', metadata: { team: 'a' } });
    expect(again.status).toBe('unchanged');
    expect(again.embedded).toBe(0);
    expect(emb.calls).toEqual([]);
    expect(mem.get('d1')!.version).toBe(1);
  });

  it('bumps the version when content changes and reuses unchanged chunk vectors', async () => {
    const emb = fakeEmbedder();
    const mem = createKnowledgeMemory({ embedder: emb, chunk: { chunkSize: 40, chunkOverlap: 0 } });
    await mem.ingest({ id: 'd1', text: 'alpha beta gamma delta epsilon zeta eta theta' });
    emb.calls.length = 0;
    const r = await mem.ingest({ id: 'd1', text: 'alpha beta gamma delta epsilon zeta eta theta CHANGED' });
    expect(r.status).toBe('updated');
    expect(mem.get('d1')!.version).toBe(2);
    // Only the changed/added chunks are re-embedded, not the whole document.
    expect(emb.calls.length).toBeLessThan(r.chunks);
  });

  it('a metadata-only change re-indexes without bumping the content version', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    await mem.ingest({ id: 'd1', text: 'identical body text' });
    const r = await mem.ingest({ id: 'd1', text: 'identical body text', metadata: { owner: 'qa' } });
    expect(r.status).toBe('updated');
    expect(mem.get('d1')!.version).toBe(1); // content hash unchanged
    expect(mem.get('d1')!.metadata.owner).toBe('qa');
  });

  it('filters retrieval by kind and by metadata object', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    await mem.ingest({ id: 'a', text: 'shared cache eviction topic', kind: 'decision', metadata: { team: 'core' } });
    await mem.ingest({ id: 'b', text: 'shared cache eviction topic', kind: 'source', metadata: { team: 'edge' } });
    const byKind = await mem.retrieve('cache eviction', { topK: 5, kinds: ['decision'] });
    expect(byKind.every((h) => h.source.kind === 'decision')).toBe(true);
    expect(byKind.some((h) => h.source.sourceId === 'a')).toBe(true);
    const byMeta = await mem.retrieve('cache eviction', { topK: 5, filter: { team: 'edge' } });
    expect(byMeta.every((h) => h.metadata.team === 'edge')).toBe(true);
  });

  it('applies the rerank hook and truncates to topK', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    await mem.ingestMany([
      { id: 'r1', text: 'first document about deploys' },
      { id: 'r2', text: 'second document about deploys' },
      { id: 'r3', text: 'third document about deploys' },
    ]);
    const hits = await mem.retrieve('deploys', {
      topK: 2,
      rerank: (_q, h) => [...h].reverse(),
    });
    expect(hits).toHaveLength(2);
  });

  it('assembles a budgeted context with citations and dedup accounting', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    await mem.ingestMany([
      { id: 'c1', text: 'payment gateway retry logic with exponential backoff and idempotency keys' },
      { id: 'c2', text: 'webhook delivery semantics at least once ordering and deduplication' },
    ]);
    const ctx = await mem.assembleContext('payment retry backoff', { tokenBudget: 200, topK: 5 });
    expect(ctx.tokens).toBeLessThanOrEqual(200);
    expect(ctx.citations.length).toBe(ctx.hits.length);
    expect(ctx.citations.length).toBeGreaterThan(0);
    for (const c of ctx.citations) {
      expect(ctx.text).toContain(c.sourceId);
    }
  });

  it('remove() drops the document from the index and persistence', async () => {
    const persistence = createMemoryKnowledgePersistence();
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), persistence });
    await mem.ingest({ id: 'x', text: 'temporary draft content' });
    expect(await mem.remove('x')).toBe(true);
    expect(await mem.remove('x')).toBe(false);
    expect(mem.get('x')).toBeUndefined();
    expect((await persistence.load()).map((d) => d.id)).toEqual([]);
    expect(await mem.retrieve('temporary draft', { topK: 3 })).toEqual([]);
  });

  it('restores from persistence and reports foreign-fingerprint docs as stale, never compared', async () => {
    const persistence = createMemoryKnowledgePersistence();
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), persistence });
    await mem.ingest({ id: 'keep', text: 'durable knowledge content' });
    // Fresh memory over the same persistence, same fingerprint: full restore.
    const same = createKnowledgeMemory({ embedder: fakeEmbedder(), persistence });
    expect(await same.load()).toEqual({ restored: 1, stale: [] });
    const hits = await same.retrieve('durable knowledge', { topK: 1 });
    expect(hits[0]!.source.sourceId).toBe('keep');
    // Different fingerprint: restored is 0 and the doc is flagged stale.
    const other = createKnowledgeMemory({ embedder: fakeEmbedder(32), persistence });
    expect(await other.load()).toEqual({ restored: 0, stale: ['keep'] });
  });

  it('falls back to lexical recall when the query vector has the wrong width', async () => {
    const embedder = {
      dimensions: 2,
      fingerprint: 'test-space',
      async embed(text: string) {
        return text === 'deploy' ? new Float32Array([1]) : new Float32Array([1, 0]);
      },
    };
    const memory = createKnowledgeMemory({ embedder });
    await memory.ingest({ id: 'keyword', text: 'deploy checklist' });
    await memory.ingest({ id: 'unrelated', text: 'unrelated topic' });

    expect((await memory.retrieve('deploy')).map((hit) => hit.source.sourceId)).toEqual(['keyword']);
    await expect(memory.ingest({ id: 'wrong-width', text: 'deploy' })).rejects.toThrow('embedding space');
    expect(memory.get('wrong-width')).toBeUndefined();
  });

  it('compact() evicts by max age while keeping protected kinds', async () => {
    const DAY = 86_400_000;
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), now: () => 10 * DAY });
    await mem.ingest({ id: 'ancient', text: 'old transient note', kind: 'source', updatedAt: 0 });
    await mem.ingest({ id: 'recent', text: 'fresh transient note', kind: 'source', updatedAt: 9 * DAY });
    await mem.ingest({ id: 'pinned', text: 'approved persistent rule', kind: 'approved', updatedAt: 0 });
    const removed = await mem.compact({ maxAgeMs: 2 * DAY });
    expect(removed.sort()).toEqual(['ancient']);
    expect(mem.get('recent')).toBeDefined();
    expect(mem.get('pinned')).toBeDefined();
  });

  it('compact() trims to maxDocuments oldest-first among non-protected kinds', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), now: () => 1000 });
    await mem.ingest({ id: 'd1', text: 'one', updatedAt: 1 });
    await mem.ingest({ id: 'd2', text: 'two', updatedAt: 2 });
    await mem.ingest({ id: 'd3', text: 'three', updatedAt: 3 });
    const removed = await mem.compact({ maxDocuments: 1 });
    expect(removed.sort()).toEqual(['d1', 'd2']);
    expect(mem.get('d3')).toBeDefined();
  });

  it('returns empty results for an empty index or non-positive topK', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    expect(await mem.retrieve('anything')).toEqual([]);
    await mem.ingest({ id: 'd1', text: 'real content here' });
    expect(await mem.retrieve('content', { topK: 0 })).toEqual([]);
  });
});
