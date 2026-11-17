/**
 * Phase 6 — text primitives: normalisation, chunking, tokenising, hashing, token
 * estimation, BM25 scoring.
 *
 * Chunking, tokenising and the Okapi BM25 core mirror the memory layer's
 * `retrieval/chunk.ts`, `similarity/index.ts` and `retrieval/bm25.ts` +
 * `knowledge-index/lexical.ts` (same defaults, same formula), restated here only
 * because this package must stay dependency-free.
 */

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

const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

/** Capture normalisation: unify newlines, collapse runs of spaces/blank lines, trim. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Recursive character splitter with overlap — memory `chunkText` semantics. */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const chunkSize = Math.max(1, opts.chunkSize ?? 1000);
  const overlap = Math.min(Math.max(0, opts.chunkOverlap ?? 200), chunkSize - 1);
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= chunkSize) return [{ text: trimmed, index: 0, start: 0 }];

  const pieces = splitRecursive(trimmed, chunkSize, SEPARATORS);
  const chunks: TextChunk[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t.length > 0) chunks.push({ text: t, index: chunks.length, start: Math.max(0, trimmed.indexOf(t)) });
    buf = '';
  };
  for (const piece of pieces) {
    if (buf.length + piece.length <= chunkSize) {
      buf += piece;
    } else {
      flush();
      const prev = chunks[chunks.length - 1]?.text ?? '';
      buf = (overlap > 0 ? prev.slice(-overlap) : '') + piece;
      while (buf.length > chunkSize) {
        const head = buf.slice(0, chunkSize);
        chunks.push({ text: head.trim(), index: chunks.length, start: Math.max(0, trimmed.indexOf(head.trim())) });
        buf = (overlap > 0 ? head.slice(-overlap) : '') + buf.slice(chunkSize);
      }
    }
  }
  flush();
  return chunks.map((c, i) => ({ ...c, index: i }));
}

function splitRecursive(text: string, chunkSize: number, separators: string[]): string[] {
  if (text.length <= chunkSize) return [text];
  const [sep, ...rest] = separators;
  if (sep === undefined) return [text];
  if (sep === '') {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize) out.push(text.slice(i, i + chunkSize));
    return out;
  }
  const parts = text.split(sep);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = i < parts.length - 1 ? parts[i]! + sep : parts[i]!;
    if (part.length > chunkSize) out.push(...splitRecursive(part, chunkSize, rest));
    else out.push(part);
  }
  return out;
}

/** Lowercase word tokens — memory `tokenize`. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[\s\W]+/).filter(Boolean);
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

const K1 = 1.5;
const B = 0.75;

/** Incremental BM25 inverted index (memory `LexicalIndex` semantics). */
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
      const df = p.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [id, f] of p) {
        const norm = 1 - B + B * (this.docs.get(id)!.len / avgdl);
        scores.set(id, (scores.get(id) ?? 0) + (idf * f * (K1 + 1)) / (f + K1 * norm));
      }
    }
    const hits: Array<{ id: string; score: number }> = [];
    for (const [id, score] of scores) if (score > 0) hits.push({ id, score });
    return hits.sort(compareHits);
  }
}

/** Score descending, then id ascending (memory `compareHits` order). */
export function compareHits(a: { id: string; score: number }, b: { id: string; score: number }): number {
  const qa = Math.round(a.score / 1e-6);
  const qb = Math.round(b.score / 1e-6);
  if (qa !== qb) return qb - qa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
