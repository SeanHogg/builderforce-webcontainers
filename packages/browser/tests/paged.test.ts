import { describe, expect, it } from 'vitest';
import { PagedKvCache } from '../src/kvcache/paged.js';
import type { CompatibilityParts } from '../src/kvcache/types.js';

const COMPAT: CompatibilityParts = {
  modelId: 'm',
  weightsHash: 'w',
  tokenizerId: 't',
  positionalConfig: 'p',
  attentionConfig: 'a',
};

function cache(maxBytes = 10_000, pageTokens = 4, bytesPerToken = 8): PagedKvCache {
  return new PagedKvCache(maxBytes, pageTokens, bytesPerToken);
}

describe('PagedKvCache', () => {
  it('misses on an empty cache and hits on an exact-prefix re-lookup', () => {
    const c = cache();
    const tokens = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(c.lookup(COMPAT, tokens).matched).toBe(0);
    expect(c.misses).toBe(1);

    c.put(COMPAT, tokens);
    const hit = c.lookup(COMPAT, tokens);
    expect(hit.matched).toBe(tokens.length);
    expect(hit.pages.length).toBe(2); // pageTokens = 4
    expect(hit.compatKey).toContain('m');
    expect(c.hits).toBe(1);
  });

  it('matches only the longest exact prefix, not a semantic one', () => {
    const c = cache();
    // Store a single page: [1,2,3,4]. A longer query that continues past
    // the page boundary with different tokens still reuses the exact page.
    c.put(COMPAT, [1, 2, 3, 4]);
    const extended = c.lookup(COMPAT, [1, 2, 3, 4, 9, 10]);
    expect(extended.matched).toBe(4);
    expect(extended.pages.length).toBe(1);
    // Diverging inside the page matches nothing — no semantic similarity.
    expect(c.lookup(COMPAT, [1, 2, 9]).matched).toBe(0);
    expect(c.lookup(COMPAT, [9, 10, 11, 12]).matched).toBe(0);
  });

  it('serves the shared prefix across sessions under one compatibility key', () => {
    const c = cache();
    c.put(COMPAT, [1, 2, 3, 4, 5, 6, 7, 8]);
    // sessionId is not part of CompatibilityParts — a second "session" with
    // the same parts reuses the resident pages.
    const hit = c.lookup(COMPAT, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(hit.matched).toBe(8);
  });

  it('never matches across different compatibility keys', () => {
    const c = cache();
    c.put(COMPAT, [1, 2, 3, 4]);
    const other: CompatibilityParts = { ...COMPAT, tokenizerId: 't2' };
    expect(c.lookup(other, [1, 2, 3, 4]).matched).toBe(0);
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(1);
  });

  it('reuses resident pages on put and reports the resident byte/page counts', () => {
    const c = cache();
    c.put(COMPAT, [1, 2, 3, 4, 5, 6, 7, 8]);
    expect(c.pages).toBe(2);
    expect(c.bytes).toBe(2 * 4 * 8); // 2 pages × 4 tokens × 8 bytes/token
    // Extending the same sequence reuses both pages and adds one.
    const { evicted } = c.put(COMPAT, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(evicted).toBe(0);
    expect(c.pages).toBe(3);
    expect(c.bytes).toBe(3 * 4 * 8);
  });

  it('evicts least-recently-used pages over the byte budget and counts them', () => {
    const c = cache(2 * 4 * 8, 4, 8); // exactly two pages fit
    c.put(COMPAT, [1, 2, 3, 4]); // page A
    c.put(COMPAT, [5, 6, 7, 8]); // page B (A now LRU)
    const { evicted } = c.put(COMPAT, [9, 10, 11, 12]); // page C evicts A
    expect(evicted).toBe(1);
    expect(c.evictions).toBe(1);
    expect(c.pages).toBe(2);
    // A is gone: the [1,2,3,4] prefix no longer resolves.
    expect(c.lookup(COMPAT, [1, 2, 3, 4]).matched).toBe(0);
    // B and C are resident.
    expect(c.lookup(COMPAT, [5, 6, 7, 8]).matched).toBe(4);
    expect(c.lookup(COMPAT, [9, 10, 11, 12]).matched).toBe(4);
  });

  it('clear() empties pages, bytes, trees and all counters', () => {
    const c = cache();
    c.put(COMPAT, [1, 2, 3, 4]);
    c.lookup(COMPAT, [1, 2, 3, 4]);
    c.clear();
    expect(c.pages).toBe(0);
    expect(c.bytes).toBe(0);
    expect(c.hits).toBe(0);
    expect(c.misses).toBe(0);
    expect(c.evictions).toBe(0);
    expect(c.lookup(COMPAT, [1, 2, 3, 4]).matched).toBe(0);
  });
});
