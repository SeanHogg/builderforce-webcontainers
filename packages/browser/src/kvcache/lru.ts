/**
 * Phase 5 — byte-bounded LRU container for KV pages. Pure TypeScript.
 *
 * Why this is not `src/residency/eviction.ts` `lruStrategy()`: that strategy is a
 * ranking POLICY — it sorts a snapshot of `TrackedEntry` records (group,
 * reload cost, reuse probability, admission sequence) that the residency
 * manager owns, O(n log n) per eviction. The paged KV cache needs a keyed
 * CONTAINER that owns its values and evicts in O(1) on every page insert, for
 * values that carry none of the residency metadata. Routing KV pages through
 * the residency manager would charge them against the model-weight budget and
 * make every page insert an async admission; the shapes genuinely differ.
 *
 * Invariant: `bytes <= maxBytes` after every call. An entry larger than
 * `maxBytes` is rejected (and any previous value under its key is dropped).
 * Recency is the Map's insertion order: a touch deletes and re-inserts.
 */

export interface LruNode<V> {
  key: string;
  value: V;
  bytes: number;
}

export class LruCache<V> {
  private readonly map = new Map<string, LruNode<V>>();
  private used = 0;

  constructor(readonly maxBytes: number) {}

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.used;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): V | undefined {
    const node = this.map.get(key);
    if (!node) return undefined;
    this.map.delete(key);
    this.map.set(key, node);
    return node.value;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  /**
   * Insert or replace `key`, evicting least-recently-used entries until the
   * cache is back inside `maxBytes`. Returns every key that left the cache —
   * including `key` itself when the new value is larger than `maxBytes` and
   * replaced a resident value (a rejected NEW key is simply not inserted).
   */
  set(key: string, value: V, bytes: number): string[] {
    const evicted: string[] = [];
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    const existed = this.remove(key);
    if (size > this.maxBytes) {
      if (existed) evicted.push(key);
      return evicted;
    }
    this.map.set(key, { key, value, bytes: size });
    this.used += size;
    for (const victim of this.map.keys()) {
      if (this.used <= this.maxBytes) break;
      if (victim === key) continue;
      this.remove(victim);
      evicted.push(victim);
    }
    return evicted;
  }

  delete(key: string): boolean {
    return this.remove(key);
  }

  clear(): void {
    this.map.clear();
    this.used = 0;
  }

  /** Keys, least recently used first. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  private remove(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.map.delete(key);
    this.used -= node.bytes;
    return true;
  }
}
