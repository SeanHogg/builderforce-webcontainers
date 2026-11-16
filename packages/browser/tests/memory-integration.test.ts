import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  createKnowledgeMemory,
  createIndexedDbKnowledgePersistence,
  createMemoryKnowledgePersistence,
  type TextEmbedder,
} from '../src/memoryIntegration/index.js';
import { estimateTokens, tokenize } from '../src/memoryIntegration/text.js';

/** Deterministic hashed bag-of-words embedder (stands in for EvermindTextEmbedder). */
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

const TOPICS = [
  'invoice billing refund payment', 'kubernetes cluster pod deployment', 'password reset login auth',
  'quarterly revenue forecast finance', 'database migration schema postgres', 'onboarding employee handbook hr',
  'pricing tier enterprise plan', 'incident outage postmortem pager', 'gdpr privacy consent data',
  'webpack bundle esbuild build', 'roadmap milestone launch q3', 'vendor contract procurement legal',
  'cache eviction lru memory', 'shipping warehouse inventory stock', 'tax vat compliance audit',
  'marketing campaign email newsletter', 'sso saml okta identity', 'latency p95 benchmark perf',
  'backup restore disaster recovery', 'design decision adr architecture',
];

describe('knowledge memory', () => {
  it('retrieves from 10,000 chunks with p95 < 500ms', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    for (let i = 0; i < 10_000; i++) {
      await mem.ingest({ id: `d${i}`, text: `filler w${i % 997} w${(i * 7) % 991} ${TOPICS[i % TOPICS.length]} item ${i}` });
    }
    expect(mem.stats().chunks).toBe(10_000);
    const times: number[] = [];
    for (let q = 0; q < 40; q++) {
      const t0 = performance.now();
      const hits = await mem.retrieve(`${TOPICS[q % TOPICS.length]} w${q}`, { topK: 5 });
      times.push(performance.now() - t0);
      expect(hits.length).toBe(5);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(500);
  }, 120_000);

  it('recall@5 >= 85% on a labeled set', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder() });
    for (let i = 0; i < TOPICS.length; i++) await mem.ingest({ id: `t${i}`, text: `Notes about ${TOPICS[i]}.` });
    for (let i = 0; i < 300; i++) await mem.ingest({ id: `n${i}`, text: `general notes misc text number ${i} about things` });
    let found = 0;
    for (let i = 0; i < TOPICS.length; i++) {
      const words = TOPICS[i]!.split(' ');
      const hits = await mem.retrieve(`${words[0]} ${words[2]}`, { topK: 5 });
      if (hits.some((h) => h.source.sourceId === `t${i}`)) found++;
    }
    expect(found / TOPICS.length).toBeGreaterThanOrEqual(0.85);
  });

  it('injects <= 50% of full-context tokens, with full citation integrity', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), chunk: { chunkSize: 200, chunkOverlap: 20 } });
    for (let i = 0; i < TOPICS.length; i++) {
      const body = Array.from({ length: 6 }, (_, j) => `Paragraph ${j} on ${TOPICS[i]} with detail ${i}-${j}.`).join('\n\n');
      await mem.ingest({ id: `doc${i}`, text: body, title: `Doc ${i}`, kind: 'business-doc' });
    }
    const naive = mem.stats().totalChunkTokens;
    const ctx = await mem.assembleContext('invoice refund payment', { tokenBudget: Math.floor(naive * 0.1), topK: 10 });
    expect(ctx.tokens).toBeLessThanOrEqual(naive * 0.5);
    expect(ctx.tokens).toBeLessThanOrEqual(Math.floor(naive * 0.1));
    expect(estimateTokens(ctx.text)).toBeLessThanOrEqual(ctx.tokens + 1);
    expect(ctx.citations.length).toBeGreaterThan(0);
    for (const c of ctx.citations) {
      const doc = mem.get(c.sourceId)!;
      expect(doc).toBeDefined();
      expect(doc.version).toBe(c.version);
      expect(doc.chunks.some((k) => k.id === c.chunkId)).toBe(true);
      expect(ctx.text).toContain(c.sourceId);
    }
    expect(ctx.citations[0]!.sourceId).toBe('doc0');
  });

  it('re-indexes only changed content', async () => {
    const emb = fakeEmbedder();
    const mem = createKnowledgeMemory({ embedder: emb });
    const docs = TOPICS.slice(0, 5).map((t, i) => ({ id: `f${i}`, text: `file about ${t}` }));
    await mem.ingestMany(docs);
    emb.calls.length = 0;
    const res = await mem.ingestMany(docs.map((d, i) => (i === 2 ? { ...d, text: d.text + ' changed' } : d)));
    expect(res.map((r) => r.status)).toEqual(['unchanged', 'unchanged', 'updated', 'unchanged', 'unchanged']);
    expect(emb.calls).toEqual([`file about ${TOPICS[2]} changed`]);
    expect(mem.get('f2')!.version).toBe(2);
    expect(mem.get('f1')!.version).toBe(1);
  });

  it('dedups duplicate chunks within a source', async () => {
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), chunk: { chunkSize: 30, chunkOverlap: 0 } });
    const r = await mem.ingest({ id: 'dup', text: 'same paragraph text\n\nsame paragraph text\n\nother bit here' });
    expect(r.chunks).toBe(2);
  });

  it('persists across restarts via IndexedDB', async () => {
    const idb = new IDBFactory();
    const a = createKnowledgeMemory({ embedder: fakeEmbedder(), persistence: createIndexedDbKnowledgePersistence({ indexedDB: idb }) });
    await a.ingest({ id: 'p1', text: 'saml okta sso identity', kind: 'decision', metadata: { team: 'auth' } });
    await a.ingest({ id: 'p2', text: 'warehouse inventory stock' });
    const emb = fakeEmbedder();
    const b = createKnowledgeMemory({ embedder: emb, persistence: createIndexedDbKnowledgePersistence({ indexedDB: idb }) });
    expect(await b.load()).toEqual({ restored: 2, stale: [] });
    const hits = await b.retrieve('okta sso', { topK: 1, filter: { team: 'auth' } });
    expect(hits[0]!.source.sourceId).toBe('p1');
    expect(hits[0]!.source.kind).toBe('decision');
    expect((await b.ingest({ id: 'p2', text: 'warehouse inventory stock' })).status).toBe('unchanged');
    const other = createKnowledgeMemory({ embedder: fakeEmbedder(32), persistence: createIndexedDbKnowledgePersistence({ indexedDB: idb }) });
    expect((await other.load()).stale.sort()).toEqual(['p1', 'p2']);
  });

  it('validates updates, deletion, retention, filters and rerank hook', async () => {
    const persistence = createMemoryKnowledgePersistence();
    const mem = createKnowledgeMemory({ embedder: fakeEmbedder(), persistence, now: () => 10 * 86_400_000 });
    await mem.ingest({ id: 'old', text: 'cache eviction policy', updatedAt: 0 });
    await mem.ingest({ id: 'new', text: 'cache eviction policy notes', updatedAt: 10 * 86_400_000 });
    await mem.ingest({ id: 'keep', text: 'approved cache rule', kind: 'approved', updatedAt: 0 });
    const recent = await mem.retrieve('cache eviction', { topK: 3, recencyHalfLifeDays: 1 });
    expect(recent[0]!.source.sourceId).toBe('new');
    expect((await mem.retrieve('cache', { kinds: ['approved'] })).map((h) => h.source.sourceId)).toEqual(['keep']);
    const rr = await mem.retrieve('cache', { topK: 1, rerank: (_q, h) => [...h].reverse() });
    expect(rr).toHaveLength(1);

    await mem.ingest({ id: 'new', text: 'totally different backup content' });
    const after = await mem.retrieve('eviction', { topK: 5 });
    expect(after.some((h) => h.source.sourceId === 'new' && h.text.includes('eviction'))).toBe(false);
    expect(after[0]!.source.sourceId).not.toBe('new');
    expect(mem.get('new')!.version).toBe(2);

    expect(await mem.remove('new')).toBe(true);
    expect(mem.get('new')).toBeUndefined();
    expect((await persistence.load()).map((d) => d.id).sort()).toEqual(['keep', 'old']);

    expect(await mem.compact({ maxAgeMs: 86_400_000 })).toEqual(['old']);
    expect(mem.get('keep')).toBeDefined();
    expect((await persistence.load()).map((d) => d.id)).toEqual(['keep']);
  });
});
