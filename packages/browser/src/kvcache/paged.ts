/**
 * Phase 5 — paged KV cache.
 *
 * Token sequences are stored as fixed-size pages keyed by a compatibility
 * key. Pages form a chain: a page's id is a rolling hash of (parent page id,
 * the page's own tokens), rooted at a hash of the compatibility key. So a
 * page id names its whole token prefix without embedding it — ids stay a few
 * dozen bytes however long the sequence is.
 *
 * Lookup walks the query page by page and stops at the first page that is not
 * resident, which finds the longest shared PAGE-ALIGNED prefix with ANY stored
 * sequence — sequences that branch after a shared prefix all reuse it. A
 * trailing partial page is matched too, via the per-parent tail index.
 *
 * Exactness: every hop re-verifies the page's compatibility key, parent id,
 * parent serial (the exact parent page object it was stored under) and
 * tokens, so a hash collision can only cause a miss, never reuse of the wrong
 * KV state. Semantic / approximate matching is never done.
 *
 * Bounds: the only state is the page LRU (charged against `maxBytes`) and the
 * tail index, whose entries are removed when their page is evicted. Sessions
 * that share a compatibility key reuse pages — the session id is NOT part of
 * the key.
 */

import { encodeCompatibilityKey } from './compatibility.js';
import { LruCache } from './lru.js';
import type { CompatibilityParts } from './types.js';

export interface KvPage {
  id: string;
  compatKey: string;
  /** Id of the page this one continues (the chain root for the first page). */
  parentId: string;
  /** Unique per inserted page. A replaced page gets a new serial, orphaning its old children. */
  serial: number;
  /** Serial of the exact parent page this one was stored under (0 = chain root). */
  parentSerial: number;
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

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MIX_SEED = 0x9747b28c;
const MIX_PRIME = 0x5bd1e995;

/** Two independent 32-bit lanes over a string and a token run → a compact id. */
function chainHash(parent: string, tokens: readonly number[]): string {
  let a = FNV_OFFSET;
  let b = MIX_SEED ^ tokens.length;
  for (let i = 0; i < parent.length; i++) {
    const c = parent.charCodeAt(i);
    a = Math.imul(a ^ c, FNV_PRIME);
    b = Math.imul(b ^ c, MIX_PRIME);
    b ^= b >>> 13;
  }
  for (const token of tokens) {
    const t = token | 0;
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (t >>> shift) & 0xff;
      a = Math.imul(a ^ byte, FNV_PRIME);
      b = Math.imul(b ^ byte, MIX_PRIME);
      b ^= b >>> 15;
    }
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${tokens.length}`;
}

function sameTokens(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isPrefixOf(prefix: readonly number[], tokens: readonly number[], offset: number): boolean {
  if (offset + prefix.length > tokens.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== tokens[offset + i]) return false;
  return true;
}

export class PagedKvCache {
  private readonly lru: LruCache<KvPage>;
  /** Partial (shorter than pageTokens) pages, by parent id. Entries leave with their page. */
  private readonly tails = new Map<string, Set<string>>();
  private readonly tailParent = new Map<string, string>();
  private nextSerial = 1;
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
    const compatKey = encodeCompatibilityKey(compat).key;
    const pages: KvPage[] = [];
    let parent = chainHash(compatKey, []);
    let parentSerial = 0;
    let matched = 0;
    while (matched < tokens.length) {
      const slice = tokens.slice(matched, matched + this.pageTokens);
      const page = this.residentPage(chainHash(parent, slice), compatKey, parent, parentSerial, slice);
      if (page) {
        pages.push(page);
        matched += page.tokens.length;
        parent = page.id;
        parentSerial = page.serial;
        if (page.tokens.length < this.pageTokens) break;
        continue;
      }
      const tail = this.longestTail(parent, parentSerial, compatKey, tokens, matched);
      if (tail) {
        pages.push(tail);
        matched += tail.tokens.length;
      }
      break;
    }
    if (matched === 0) {
      this.misses++;
      return { matched: 0, pages: [], compatKey };
    }
    this.hits++;
    return { matched, pages, compatKey };
  }

  /**
   * Store (or extend) a sequence under a compatibility key. Pages covering
   * tokens already resident are reused; new pages are inserted and may
   * trigger LRU eviction of the least-recently-used pages.
   */
  put(compat: CompatibilityParts, tokens: readonly number[]): { evicted: number } {
    const compatKey = encodeCompatibilityKey(compat).key;
    let parent = chainHash(compatKey, []);
    let parentSerial = 0;
    let evictedThis = 0;
    for (let i = 0; i < tokens.length; i += this.pageTokens) {
      const slice = tokens.slice(i, i + this.pageTokens);
      const id = chainHash(parent, slice);
      let page = this.residentPage(id, compatKey, parent, parentSerial, slice);
      if (!page) {
        page = {
          id,
          compatKey,
          parentId: parent,
          serial: this.nextSerial++,
          parentSerial,
          tokens: slice,
          bytes: slice.length * this.bytesPerToken,
        };
        // A stale or colliding page under this id (verification failed above) is replaced.
        this.forgetTail(id);
        const evicted = this.lru.set(id, page, page.bytes);
        this.evictions += evicted.length;
        evictedThis += evicted.length;
        this.dropEvicted(evicted);
        if (!this.lru.has(id)) break; // A page that cannot fit ends the chain.
        if (slice.length < this.pageTokens) this.rememberTail(parent, id);
      }
      parent = id;
      parentSerial = page.serial;
    }
    return { evicted: evictedThis };
  }

  clear(): void {
    this.lru.clear();
    this.tails.clear();
    this.tailParent.clear();
    this.evictions = 0;
    this.hits = 0;
    this.misses = 0;
  }

  /** A resident page whose identity is verified, touched as most recently used. */
  private residentPage(
    id: string,
    compatKey: string,
    parent: string,
    parentSerial: number,
    slice: readonly number[],
  ): KvPage | undefined {
    const page = this.lru.peek(id);
    if (!page || !this.childOf(page, compatKey, parent, parentSerial) || !sameTokens(page.tokens, slice)) {
      return undefined;
    }
    this.lru.get(id);
    return page;
  }

  private childOf(page: KvPage, compatKey: string, parent: string, parentSerial: number): boolean {
    return page.compatKey === compatKey && page.parentId === parent && page.parentSerial === parentSerial;
  }

  /** Longest resident partial page under `parent` whose tokens continue the query at `offset`. */
  private longestTail(
    parent: string,
    parentSerial: number,
    compatKey: string,
    tokens: readonly number[],
    offset: number,
  ): KvPage | undefined {
    const ids = this.tails.get(parent);
    if (!ids) return undefined;
    let best: KvPage | undefined;
    for (const id of ids) {
      const page = this.lru.peek(id);
      if (!page || !this.childOf(page, compatKey, parent, parentSerial)) continue;
      if (!isPrefixOf(page.tokens, tokens, offset)) continue;
      if (!best || page.tokens.length > best.tokens.length) best = page;
    }
    if (best) this.lru.get(best.id);
    return best;
  }

  private rememberTail(parent: string, id: string): void {
    let ids = this.tails.get(parent);
    if (!ids) {
      ids = new Set();
      this.tails.set(parent, ids);
    }
    ids.add(id);
    this.tailParent.set(id, parent);
  }

  private forgetTail(id: string): void {
    const parent = this.tailParent.get(id);
    if (parent === undefined) return;
    this.tailParent.delete(id);
    const ids = this.tails.get(parent);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) this.tails.delete(parent);
  }

  /**
   * Evicted pages leave every index with them. A descendant of an evicted
   * page stays resident until the LRU reaches it, but is unreachable: lookup
   * stops at the first missing page, so it is a miss and recompute.
   */
  private dropEvicted(ids: readonly string[]): void {
    for (const id of ids) this.forgetTail(id);
  }

  /** Number of tail-index entries (diagnostics / bound checks). */
  get indexedTails(): number {
    return this.tailParent.size;
  }
}
