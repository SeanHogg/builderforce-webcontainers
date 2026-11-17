/**
 * Phase 6 — the persistent knowledge/retrieval layer.
 *
 * Lifecycle: capture → normalise → chunk → metadata → embed (injected embedder)
 * → index (BM25 + dense) → retrieve (hybrid RRF + filters + recency + rerank hook)
 * → assemble context (dedup, compress, token budget, citations) → update/delete →
 * compact (retention). Incremental: a document whose normalised content hash is
 * unchanged is never re-embedded; a changed document re-embeds only chunks whose
 * hash is new. Vectors are stamped with the embedder fingerprint; on restore a
 * document made under another fingerprint is reported stale, never compared.
 */

import {
  LexicalIndex,
  chunkText,
  compareHits,
  contentHash,
  normalizeText,
  toUnit,
  type ChunkOptions,
} from './text.js';
import { estimateTokens } from '../shared/tokens.js';
import type {
  AssembledContext,
  ContextOptions,
  IngestResult,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgePersistence,
  RetentionPolicy,
  RetrieveOptions,
  SourceReference,
  StoredChunk,
  StoredKnowledgeDoc,
  TextEmbedder,
} from './types.js';

export interface KnowledgeMemoryOptions {
  embedder: TextEmbedder;
  persistence?: KnowledgePersistence;
  chunk?: ChunkOptions;
  /** Clock (epoch ms). Default `Date.now`. */
  now?: () => number;
}

export interface KnowledgeMemoryStats {
  documents: number;
  chunks: number;
  totalChunkTokens: number;
}

export interface KnowledgeMemory {
  /** Restore the persisted index. Returns ids of documents made under another embedder fingerprint (need re-ingest). */
  load(): Promise<{ restored: number; stale: string[] }>;
  ingest(doc: KnowledgeDocument): Promise<IngestResult>;
  ingestMany(docs: KnowledgeDocument[]): Promise<IngestResult[]>;
  remove(id: string): Promise<boolean>;
  get(id: string): StoredKnowledgeDoc | undefined;
  retrieve(query: string, opts?: RetrieveOptions): Promise<KnowledgeHit[]>;
  assembleContext(query: string, opts: ContextOptions): Promise<AssembledContext>;
  /** Retention/maintenance; returns removed ids. */
  compact(policy: RetentionPolicy): Promise<string[]>;
  stats(): KnowledgeMemoryStats;
}

const DAY_MS = 86_400_000;

export function createKnowledgeMemory(options: KnowledgeMemoryOptions): KnowledgeMemory {
  const { embedder, persistence } = options;
  const clock = options.now ?? Date.now;
  const docs = new Map<string, StoredKnowledgeDoc>();
  const chunks = new Map<string, { doc: StoredKnowledgeDoc; chunk: StoredChunk }>();
  const lexical = new LexicalIndex();

  const indexDoc = (doc: StoredKnowledgeDoc) => {
    docs.set(doc.id, doc);
    for (const c of doc.chunks) {
      chunks.set(c.id, { doc, chunk: c });
      lexical.set(c.id, doc.title ? `${doc.title}\n${c.text}` : c.text);
    }
  };
  const unindexDoc = (id: string) => {
    const doc = docs.get(id);
    if (!doc) return;
    for (const c of doc.chunks) {
      chunks.delete(c.id);
      lexical.delete(c.id);
    }
    docs.delete(id);
  };

  const refOf = (doc: StoredKnowledgeDoc, c: StoredChunk): SourceReference => ({
    sourceId: doc.id,
    version: doc.version,
    contentHash: doc.contentHash,
    chunkId: c.id,
    chunkIndex: c.index,
    start: c.start,
    kind: doc.kind,
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    ...(doc.uri !== undefined ? { uri: doc.uri } : {}),
  });

  const passes = (doc: StoredKnowledgeDoc, opts: RetrieveOptions): boolean => {
    if (opts.kinds && !opts.kinds.includes(doc.kind)) return false;
    const f = opts.filter;
    if (!f) return true;
    if (typeof f === 'function') return f(doc);
    for (const [k, v] of Object.entries(f)) if (doc.metadata[k] !== v) return false;
    return true;
  };

  // Per-id mutation chain: ingest/remove of the same id run strictly in CALL
  // order, so the last call wins in the index AND in persistence (a slow embed
  // of an older version can never overwrite a newer one). Different ids run
  // concurrently.
  const tails = new Map<string, Promise<unknown>>();
  function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const run = (tails.get(id) ?? Promise.resolve()).then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    return run;
  }

  const ingest = (input: KnowledgeDocument): Promise<IngestResult> => serialize(input.id, () => ingestNow(input));

  async function ingestNow(input: KnowledgeDocument): Promise<IngestResult> {
    const text = normalizeText(input.text);
    const hash = contentHash(text);
    const prior = docs.get(input.id);
    const kind = input.kind ?? 'business-doc';
    const metaSame =
      prior !== undefined &&
      prior.kind === kind &&
      prior.title === input.title &&
      prior.uri === input.uri &&
      JSON.stringify(prior.metadata) === JSON.stringify(input.metadata ?? {});
    if (prior && prior.contentHash === hash && prior.fingerprint === embedder.fingerprint && metaSame) {
      return { id: input.id, status: 'unchanged', version: prior.version, chunks: prior.chunks.length, embedded: 0 };
    }

    // Reuse vectors of chunks whose text is unchanged (same fingerprint only).
    const reusable = new Map<string, Float32Array>();
    if (prior && prior.fingerprint === embedder.fingerprint) for (const c of prior.chunks) reusable.set(c.hash, c.vector);

    const seen = new Set<string>();
    const stored: StoredChunk[] = [];
    let embedded = 0;
    for (const piece of chunkText(text, options.chunk)) {
      const h = contentHash(piece.text);
      if (seen.has(h)) continue; // duplicate chunk within the source
      seen.add(h);
      let vector = reusable.get(h);
      if (!vector) {
        vector = toUnit(await embedder.embed(piece.text));
        embedded++;
      }
      stored.push({
        id: `${input.id}#${stored.length}`,
        index: stored.length,
        start: piece.start,
        text: piece.text,
        hash: h,
        tokens: estimateTokens(piece.text),
        vector,
      });
    }

    const doc: StoredKnowledgeDoc = {
      id: input.id,
      kind,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.uri !== undefined ? { uri: input.uri } : {}),
      metadata: { ...(input.metadata ?? {}) },
      updatedAt: input.updatedAt ?? clock(),
      version: prior && prior.contentHash === hash ? prior.version : (prior?.version ?? 0) + 1,
      contentHash: hash,
      fingerprint: embedder.fingerprint,
      chunks: stored,
    };
    unindexDoc(input.id);
    indexDoc(doc);
    await persistence?.put(doc);
    return { id: doc.id, status: prior ? 'updated' : 'added', version: doc.version, chunks: stored.length, embedded };
  }

  async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<KnowledgeHit[]> {
    const topK = opts.topK ?? 5;
    const pool = opts.candidatePool ?? 100;
    const rrfK = opts.rrfK ?? 60;
    if (chunks.size === 0 || topK <= 0) return [];

    const sparse: string[] = [];
    for (const h of lexical.search(query)) {
      if (sparse.length >= pool) break;
      if (passes(chunks.get(h.id)!.doc, opts)) sparse.push(h.id);
    }

    const qv = toUnit(await embedder.embed(query));
    const dense: Array<{ id: string; score: number }> = [];
    for (const [id, { doc, chunk }] of chunks) {
      if (!passes(doc, opts)) continue;
      const v = chunk.vector;
      const n = Math.min(v.length, qv.length);
      let dot = 0;
      for (let i = 0; i < n; i++) dot += v[i]! * qv[i]!;
      dense.push({ id, score: dot });
    }
    dense.sort(compareHits);

    const fused = new Map<string, number>();
    const add = (ids: string[], w: number) =>
      ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + w / (rrfK + rank + 1)));
    add(dense.slice(0, pool).map((d) => d.id), opts.denseWeight ?? 1);
    add(sparse, opts.sparseWeight ?? 1);

    const now = opts.now ?? clock();
    const halfLife = opts.recencyHalfLifeDays ?? 0;
    const ranked = [...fused].map(([id, score]) => {
      if (halfLife > 0) {
        const age = Math.max(0, (now - chunks.get(id)!.doc.updatedAt) / DAY_MS);
        score *= Math.exp((-Math.LN2 / halfLife) * age);
      }
      return { id, score };
    });
    ranked.sort(compareHits);

    let hits: KnowledgeHit[] = ranked.slice(0, opts.rerank ? Math.max(topK * 4, topK) : topK).map(({ id, score }) => {
      const { doc, chunk } = chunks.get(id)!;
      return { chunkId: id, text: chunk.text, score, source: refOf(doc, chunk), metadata: { ...doc.metadata } };
    });
    if (opts.rerank) hits = (await opts.rerank(query, hits)).slice(0, topK);
    return hits;
  }

  async function assembleContext(query: string, opts: ContextOptions): Promise<AssembledContext> {
    const hits = await retrieve(query, { ...opts, topK: opts.topK ?? 8 });
    const kept: KnowledgeHit[] = [];
    const parts: string[] = [];
    const seenHashes = new Set<string>();
    let tokens = 0;
    let duplicatesRemoved = 0;
    let droppedForBudget = 0;
    for (const hit of hits) {
      const compressed = hit.text.replace(/\s+/g, ' ').trim();
      const h = contentHash(compressed);
      if (seenHashes.has(h) || parts.some((p) => p.includes(compressed))) {
        duplicatesRemoved++;
        continue;
      }
      const s = hit.source;
      const block = `[${kept.length + 1}] ${s.sourceId} v${s.version} §${s.chunkIndex}\n${compressed}`;
      const t = estimateTokens(block) + (parts.length > 0 ? 1 : 0);
      if (tokens + t > opts.tokenBudget) {
        droppedForBudget++;
        continue;
      }
      seenHashes.add(h);
      parts.push(block);
      kept.push(hit);
      tokens += t;
    }
    return {
      text: parts.join('\n\n'),
      tokens,
      citations: kept.map((k) => k.source),
      hits: kept,
      duplicatesRemoved,
      droppedForBudget,
    };
  }

  function remove(id: string): Promise<boolean> {
    return serialize(id, async () => {
      const had = docs.has(id);
      unindexDoc(id);
      await persistence?.delete(id);
      return had;
    });
  }

  return {
    async load() {
      const stale: string[] = [];
      let restored = 0;
      for (const d of persistence ? await persistence.load() : []) {
        if (d.fingerprint !== embedder.fingerprint) {
          stale.push(d.id);
          continue;
        }
        unindexDoc(d.id);
        indexDoc({ ...d, chunks: d.chunks.map((c) => ({ ...c, vector: Float32Array.from(c.vector) })) });
        restored++;
      }
      return { restored, stale };
    },
    ingest,
    async ingestMany(list) {
      const out: IngestResult[] = [];
      for (const d of list) out.push(await ingest(d));
      return out;
    },
    remove,
    get: (id) => docs.get(id),
    retrieve,
    assembleContext,
    async compact(policy) {
      const now = policy.now ?? clock();
      const keep = new Set(policy.keepKinds ?? ['approved']);
      const removed: string[] = [];
      const candidates = [...docs.values()].filter((d) => !keep.has(d.kind));
      if (policy.maxAgeMs !== undefined) {
        for (const d of candidates) if (now - d.updatedAt > policy.maxAgeMs) removed.push(d.id);
      }
      if (policy.maxDocuments !== undefined) {
        const over = docs.size - removed.length - policy.maxDocuments;
        if (over > 0) {
          const rest = candidates
            .filter((d) => !removed.includes(d.id))
            .sort((a, b) => a.updatedAt - b.updatedAt || (a.id < b.id ? -1 : 1));
          removed.push(...rest.slice(0, over).map((d) => d.id));
        }
      }
      for (const id of removed) await remove(id);
      return removed;
    },
    stats() {
      let total = 0;
      for (const { chunk } of chunks.values()) total += chunk.tokens;
      return { documents: docs.size, chunks: chunks.size, totalChunkTokens: total };
    },
  };
}
