/**
 * Phase 5 — small LRU. Phase 3 `src/memory/` is not present in this tree,
 * so the paged KV cache uses this local eviction strategy. Pure TypeScript.
 */

export interface LruNode<V> {
  key: string;
  value: V;
  bytes: number;
}

export class LruCache<V> {
  private readonly order: string[] = [];
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
    this.touch(key);
    return node.value;
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  set(key: string, value: V, bytes: number): string[] {
    const evicted: string[] = [];
    const existing = this.map.get(key);
    if (existing) {
      this.used -= existing.bytes;
      existing.value = value;
      existing.bytes = bytes;
      this.used += bytes;
      this.touch(key);
    } else {
      this.map.set(key, { key, value, bytes });
      this.order.push(key);
      this.used += bytes;
    }
    while (this.used > this.maxBytes && this.order.length > 0) {
      const victim = this.order[0];
      if (victim === undefined) break;
      // Never evict the key we just inserted if it is the only resident.
      if (victim === key && this.order.length === 1) break;
      this.order.shift();
      const node = this.map.get(victim);
      if (!node) continue;
      this.map.delete(victim);
      this.used -= node.bytes;
      if (victim !== key) evicted.push(victim);
    }
    return evicted;
  }

  delete(key: string): boolean {
    const node = this.map.get(key);
    if (!node) return false;
    this.map.delete(key);
    this.used -= node.bytes;
    const idx = this.order.indexOf(key);
    if (idx >= 0) this.order.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.map.clear();
    this.order.length = 0;
    this.used = 0;
  }

  keys(): string[] {
    return this.order.slice();
  }

  private touch(key: string): void {
    const idx = this.order.indexOf(key);
    if (idx < 0) return;
    this.order.splice(idx, 1);
    this.order.push(key);
  }
}
