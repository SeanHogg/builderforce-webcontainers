import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/kvcache/lru.js';
import { PagedKvCache } from '../src/kvcache/paged.js';
import { createKvCacheRuntime } from '../src/kvcache/runtime.js';
import type { CompatibilityParts, KvGenerateRequest } from '../src/kvcache/types.js';

const COMPAT: CompatibilityParts = {
  modelId: 'm',
  weightsHash: 'w',
  tokenizerId: 't',
  positionalConfig: 'p',
  attentionConfig: 'a',
};

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe('LruCache — oversize entries', () => {
  it('rejects a new entry larger than maxBytes and keeps bytes <= maxBytes', () => {
    const lru = new LruCache<string>(10);
    lru.set('a', 'A', 6);
    expect(lru.set('big', 'B', 20)).toEqual([]);
    expect(lru.has('big')).toBe(false);
    expect(lru.has('a')).toBe(true);
    expect(lru.bytes).toBe(6);
  });

  it('drops the resident value when its key is replaced by an oversize one', () => {
    const lru = new LruCache<string>(10);
    lru.set('a', 'A', 6);
    expect(lru.set('a', 'A2', 11)).toEqual(['a']);
    expect(lru.has('a')).toBe(false);
    expect(lru.bytes).toBe(0);
    expect(lru.bytes).toBeLessThanOrEqual(lru.maxBytes);
  });
});

describe('PagedKvCache — shared-prefix reuse and bounds', () => {
  it('matches the longest shared page-aligned prefix across branching sequences', () => {
    const c = new PagedKvCache(10_000, 4, 8);
    c.put(COMPAT, range(1, 12));
    // A second sequence branches after the first page.
    c.put(COMPAT, [1, 2, 3, 4, 20, 21, 22, 23]);
    expect(c.lookup(COMPAT, [1, 2, 3, 4, 20, 21, 22, 23, 99]).matched).toBe(8);
    // A query that diverges inside the second page still reuses the first page.
    expect(c.lookup(COMPAT, [1, 2, 3, 4, 5, 6, 0, 0]).matched).toBe(4);
    // A stored sequence longer than the query is not required to be a prefix of it.
    expect(c.lookup(COMPAT, [...range(1, 8), 50]).matched).toBe(8);
  });

  it('matches a stored trailing partial page', () => {
    const c = new PagedKvCache(10_000, 4, 8);
    c.put(COMPAT, range(1, 6));
    const hit = c.lookup(COMPAT, range(1, 7));
    expect(hit.matched).toBe(6);
    expect(hit.pages.map((page) => page.tokens.length)).toEqual([4, 2]);
  });

  it('keeps every index bounded by the page budget', () => {
    const maxBytes = 3 * 4 * 8; // three full pages
    const c = new PagedKvCache(maxBytes, 4, 8);
    // Each sequence is one full page plus a 2-token tail page.
    for (let i = 0; i < 200; i++) c.put(COMPAT, [i, i + 1, i + 2, i + 3, i + 4, i + 5]);
    expect(c.bytes).toBeLessThanOrEqual(maxBytes);
    expect(c.pages).toBeLessThanOrEqual(maxBytes / (2 * 8)); // no page is smaller than a 2-token tail
    expect(c.indexedTails).toBeLessThanOrEqual(c.pages);
    expect(c.evictions).toBeGreaterThan(0);
  });

  it('uses compact page ids however long the prefix is', () => {
    const c = new PagedKvCache(100_000_000, 16, 1);
    const tokens = range(1, 4096);
    c.put(COMPAT, tokens);
    const hit = c.lookup(COMPAT, tokens);
    expect(hit.matched).toBe(4096);
    for (const page of hit.pages) expect(page.id.length).toBeLessThan(40);
  });
});

describe('createKvCacheRuntime — bounded sessions', () => {
  it('remembers at most maxSessions distinct session ids', async () => {
    const rt = createKvCacheRuntime({ maxSessions: 3 });
    const base: KvGenerateRequest = {
      tokens: range(1, 8),
      model: { id: 'tiny', quantization: 'q4' },
      tokenizerId: 'tok',
      positionalConfig: 'rope',
      attentionConfig: 'mha',
    };
    for (let i = 0; i < 10; i++) await rt.generate({ ...base, sessionId: `s${i}` });
    expect(rt.stats().sessions).toBe(3);
  });
});
