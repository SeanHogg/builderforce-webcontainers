/**
 * Phase 5 — radix-tree prefix index over token sequences.
 *
 * Each node is keyed by a single token id. A match walks the tree while
 * tokens equal the query; the first mismatch stops. This is EXACT prefix
 * reuse only — never semantic / approximate.
 *
 * Public primitive (exported from the kvcache barrel). The paged KV cache no
 * longer stores per-sequence trees: its hash-chained page ids already index
 * every shared prefix, inside the page LRU's byte budget.
 */

export interface RadixMatch<V> {
  length: number;
  value: V;
}

interface RadixNode<V> {
  children: Map<number, RadixNode<V>>;
  value?: V;
}

export class TokenRadix<V> {
  private readonly root: RadixNode<V> = { children: new Map() };
  private n = 0;

  get size(): number {
    return this.n;
  }

  insert(tokens: readonly number[], value: V): void {
    let node = this.root;
    for (const t of tokens) {
      let child = node.children.get(t);
      if (!child) {
        child = { children: new Map() };
        node.children.set(t, child);
      }
      node = child;
    }
    if (node.value === undefined) this.n++;
    node.value = value;
  }

  /**
   * Longest stored prefix that is an exact prefix of `tokens`.
   * Returns undefined when no stored sequence shares the first token.
   */
  longestPrefix(tokens: readonly number[]): RadixMatch<V> | undefined {
    let node = this.root;
    let last: RadixMatch<V> | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === undefined) break;
      const child = node.children.get(t);
      if (!child) break;
      node = child;
      if (node.value !== undefined) last = { length: i + 1, value: node.value };
    }
    return last;
  }

  clear(): void {
    this.root.children.clear();
    this.root.value = undefined;
    this.n = 0;
  }
}
