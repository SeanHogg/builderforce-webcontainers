/**
 * Phase 5 — paged KV cache.
 *
 * Token sequences are stored as fixed-size pages keyed by a compatibility
 * key. A radix tree per compatibility key finds the longest EXACT prefix;
 * an LRU of pages enforces the size limit. Sessions that share a
 * compatibility key reuse pages — the session id is NOT part of the key.
 */

import { encodeCompatibilityKey, exactPrefixLength } from './compatibility.js';
import { LruCache } from './lru.js';
import { TokenRadix } from './radix.js';
import type { CompatibilityParts } from './types.js';

export interface KvPage {
  id: string;
  compatKey: string;
  /** Token ids this page covers (length ≤ pageTokens). */
  tokens: number[];
  /** Simulated KV bytes for this page. */
  bytes: number;
}

export interface PrefixHit {
  matched: number;
  pages: KvPage[];
  compatKey: string;
}

interface SequenceRecord {
  tokens: number[];
  pageIds: string[];
}

export class PagedKvCache {
  private readonly lru: LruCache<KvPage>;
  private readonly trees = new Map<string, TokenRadix<SequenceRecord>>();
  private sequences = 0;
  evictions = 0;
  hits = 0;
  misses = 0;

  constructor(
    readonly maxBytes: number,
    readonly pageTokens: number,
    readonly bytesPerToken: number,
  ) {
    this.lru = new LruCache<KvPage>(maxBytes);
  }

  get pages(): number {
    return this.lru.size;
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  lookup(compat: CompatibilityParts, tokens: readonly number[]): PrefixHit {
    const encoded = encodeCompatibilityKey(compat);
    const tree = this.trees.get(encoded.key);
    if (!tree) {
      this.misses++;
      return { matched: 0, pages: [], compatKey: encoded.key };
    }
    const match = tree.longestPrefix(tokens);
    if (!match || match.length === 0) {
      this.misses++;
      return { matched: 0, pages: [], compatKey: encoded.key };
    }
    // Re-verify exact prefix against the stored sequence (defence in depth).
    const matched = exactPrefixLength(match.value.tokens, tokens);
    if (matched === 0) {
      this.misses++;
      return { matched: 0, pages: [], compatKey: encoded.key };
    }
    const pages: KvPage[] = [];
    for (const id of match.value.pageIds) {
      const page = this.lru.get(id);
      if (!page) break;
      pages.push(page);
      if (pages.reduce((n, p) => n + p.tokens.length, 0) >= matched) break;
    }
    const available = pages.reduce((n, p) => n + p.tokens.length, 0);
    const actual = Math.min(matched, available);
    if (actual === 0) {
      this.misses++;
      return { matched: 0, pages: [], compatKey: encoded.key };
    }
    this.hits++;
    return { matched: actual, pages, compatKey: encoded.key };
  }

  /**
   * Store (or extend) a sequence under a compatibility key. Pages covering
   * tokens already resident are reused; new pages are inserted and may
   * trigger LRU eviction of the least-recently-used pages.
   */
  put(compat: CompatibilityParts, tokens: readonly number[]): { evicted: number } {
    const encoded = encodeCompatibilityKey(compat);
    let tree = this.trees.get(encoded.key);
    if (!tree) {
      tree = new TokenRadix<SequenceRecord>();
      this.trees.set(encoded.key, tree);
    }
    const pageIds: string[] = [];
    let evictedThis = 0;
    for (let i = 0; i < tokens.length; i += this.pageTokens) {
      const slice = tokens.slice(i, i + this.pageTokens);
      const id = pageId(encoded.key, tokens.slice(0, i + slice.length));
      const bytes = slice.length * this.bytesPerToken;
      const existing = this.lru.peek(id);
      if (existing) {
        this.lru.get(id);
        pageIds.push(id);
        continue;
      }
      const evicted = this.lru.set(id, { id, compatKey: encoded.key, tokens: slice.slice(), bytes }, bytes);
      this.evictions += evicted.length;
      evictedThis += evicted.length;
      this.dropEvicted(evicted);
      if (this.lru.has(id)) pageIds.push(id);
    }
    tree.insert(tokens.slice(), { tokens: tokens.slice(), pageIds });
    this.sequences++;
    return { evicted: evictedThis };
  }

  clear(): void {
    this.lru.clear();
    this.trees.clear();
    this.sequences = 0;
    this.evictions = 0;
    this.hits = 0;
    this.misses = 0;
  }

  private dropEvicted(ids: string[]): void {
    if (ids.length === 0) return;
    // Evicted pages invalidate sequences that referenced them; the next
    // lookup will miss and recompute. Trees stay; missing pages = miss.
    void ids;
  }
}

function pageId(compatKey: string, prefix: readonly number[]): string {
  return `${compatKey}#${prefix.join(',')}`;
}
