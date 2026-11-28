import {
  bm25Idf,
  bm25LengthNorm,
  bm25TermScore,
  chunkText as splitText,
  compareHits,
  tokenize,
} from '@seanhogg/builderforce-memory/retrieval';

export { compareHits, tokenize };

export interface TextChunk {
  text: string;
  index: number;
  start: number;
}

export interface ChunkOptions {
  /** Max chunk size in characters. Default 1000 (memory default). */
  chunkSize?: number;
  /** Overlap carried between chunks. Default 200 (memory default). */
  chunkOverlap?: number;
}

/** Capture normalisation: unify newlines, collapse runs of spaces/blank lines, trim. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Retain the browser citation offsets for hard-split chunks. */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const trimmed = text.trim();
  return splitText(trimmed, opts).map((chunk) => ({
    ...chunk,
    start: chunk.start || Math.max(0, trimmed.indexOf(chunk.text)),
  }));
}

/** Estimated prompt tokens (~4 chars/token) — the shared heuristic, re-exported for this module's API. */
export { estimateTokens } from '../shared/tokens.js';

/**
 * Content hash: two independent 32-bit FNV-1a lanes → 16 hex chars. Synchronous and
 * portable; used for change detection and duplicate-chunk identity, not security.
 */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 13);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Scale `v` to unit length (a copy). Zero vectors stay zero. */
export function toUnit(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < out.length; i++) n += out[i]! * out[i]!;
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / n;
  return out;
}

/** Incremental postings over the browser document store, using shared BM25 scoring. */
export class LexicalIndex {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly docs = new Map<string, { terms: string[]; len: number }>();
  private totalLen = 0;

  set(id: string, text: string): void {
    this.delete(id);
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, f] of tf) {
      let p = this.postings.get(term);
      if (!p) this.postings.set(term, (p = new Map()));
      p.set(id, f);
    }
    this.docs.set(id, { terms: [...tf.keys()], len: tokens.length });
    this.totalLen += tokens.length;
  }

  delete(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.terms) {
      const p = this.postings.get(term);
      p?.delete(id);
      if (p && p.size === 0) this.postings.delete(term);
    }
    this.totalLen -= doc.len;
    this.docs.delete(id);
  }

  /** Every positive-scoring id, best first (score desc, id asc). */
  search(query: string): Array<{ id: string; score: number }> {
    const n = this.docs.size;
    if (n === 0) return [];
    const avgdl = this.totalLen / n || 1;
    const scores = new Map<string, number>();
    for (const term of [...new Set(tokenize(query))].sort()) {
      const p = this.postings.get(term);
      if (!p) continue;
      const idf = bm25Idf(n, p.size);
      for (const [id, f] of p) {
        const norm = bm25LengthNorm(this.docs.get(id)!.len, avgdl);
        scores.set(id, (scores.get(id) ?? 0) + bm25TermScore(f, idf, norm));
      }
    }
    const hits: Array<{ id: string; score: number }> = [];
    for (const [id, score] of scores) if (score > 0) hits.push({ id, score });
    return hits.sort(compareHits);
  }
}
