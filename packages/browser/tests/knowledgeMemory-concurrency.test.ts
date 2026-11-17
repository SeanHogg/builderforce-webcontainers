import { describe, expect, it } from 'vitest';
import { createKnowledgeMemory } from '../src/memoryIntegration/knowledgeMemory.js';
import type { KnowledgePersistence, StoredKnowledgeDoc, TextEmbedder } from '../src/memoryIntegration/types.js';

/** Embedder whose latency depends on the text, so an older call can finish last. */
function slowFirstEmbedder(): TextEmbedder {
  return {
    dimensions: 4,
    fingerprint: 'slow/4',
    async embed(text: string) {
      await new Promise((r) => setTimeout(r, text.includes('OLD') ? 30 : 1));
      return Float32Array.from([1, text.length % 7, 0, 1]);
    },
  };
}

function recordingPersistence(): KnowledgePersistence & { writes: string[]; map: Map<string, StoredKnowledgeDoc> } {
  const writes: string[] = [];
  const map = new Map<string, StoredKnowledgeDoc>();
  return {
    writes,
    map,
    async load() {
      return [...map.values()];
    },
    async put(doc) {
      writes.push(doc.chunks.map((c) => c.text).join(''));
      map.set(doc.id, doc);
    },
    async delete(id) {
      writes.push(`delete:${id}`);
      map.delete(id);
    },
  };
}

describe('createKnowledgeMemory concurrent mutations of one id', () => {
  it('the last CALLED ingest wins in the index and in persistence', async () => {
    const persistence = recordingPersistence();
    const mem = createKnowledgeMemory({ embedder: slowFirstEmbedder(), persistence });
    const [older, newer] = await Promise.all([
      mem.ingest({ id: 'd', text: 'OLD version of the document' }),
      mem.ingest({ id: 'd', text: 'new version of the document' }),
    ]);
    expect(older.version).toBe(1);
    expect(newer.version).toBe(2);
    expect(mem.get('d')?.chunks.map((c) => c.text).join('')).toContain('new version');
    expect(persistence.map.get('d')?.chunks.map((c) => c.text).join('')).toContain('new version');
    expect(persistence.writes.map((w) => (w.includes('OLD') ? 'old' : 'new'))).toEqual(['old', 'new']);
  });

  it('a remove called after an in-flight ingest leaves the document removed', async () => {
    const persistence = recordingPersistence();
    const mem = createKnowledgeMemory({ embedder: slowFirstEmbedder(), persistence });
    const ingesting = mem.ingest({ id: 'd', text: 'OLD slow content' });
    const removed = mem.remove('d');
    await Promise.all([ingesting, removed]);
    expect(await removed).toBe(true);
    expect(mem.get('d')).toBeUndefined();
    expect(persistence.map.has('d')).toBe(false);
    expect(persistence.writes.at(-1)).toBe('delete:d');
  });
});
