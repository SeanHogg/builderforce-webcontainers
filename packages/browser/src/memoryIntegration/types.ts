/**
 * Phase 6 — BuilderForce Memory Integration: shared types.
 *
 * This is an ADAPTER over the memory layer's primitives, not a copy of the memory
 * package. The embedder seam is structurally identical to the memory-engine's
 * `TextEmbedder` (`EvermindTextEmbedder` in `memory-engine/src/lm/text_embedder.ts`):
 * `embed(text) → Float32Array`, `dimensions`, `fingerprint`. A host passes an
 * `EvermindTextEmbedder` straight in; there is no import dependency on it.
 */

/** Text → vector seam. Matches the memory-engine `TextEmbedder` interface exactly. */
export interface TextEmbedder {
  /** Embed `text` as a vector of length {@link dimensions} (normalised here defensively). */
  embed(text: string): Promise<Float32Array>;
  readonly dimensions: number;
  /** Model+tokenizer identity. Vectors are only comparable within one fingerprint. */
  readonly fingerprint: string;
}

/** The knowledge classes the persistent layer holds. */
export type KnowledgeKind = 'business-doc' | 'source' | 'project' | 'structured' | 'decision' | 'approved';

export type MetadataValue = string | number | boolean;

/** One captured source document (a file, a business doc, a decision record, …). */
export interface KnowledgeDocument {
  /** Stable id in the origin system. Re-ingesting the same id replaces its chunks. */
  id: string;
  text: string;
  kind?: KnowledgeKind;
  title?: string;
  uri?: string;
  metadata?: Record<string, MetadataValue>;
  /** Write time (epoch ms) used by recency ranking and retention. Default `now`. */
  updatedAt?: number;
}

/** Where a returned passage came from — carried by EVERY hit and citation. */
export interface SourceReference {
  sourceId: string;
  /** Increments each time the source's content changes. */
  version: number;
  contentHash: string;
  chunkId: string;
  chunkIndex: number;
  /** Character offset of the chunk within the normalised source. */
  start: number;
  kind: KnowledgeKind;
  title?: string;
  uri?: string;
}

export interface StoredChunk {
  id: string;
  index: number;
  start: number;
  text: string;
  hash: string;
  tokens: number;
  /** Unit-length embedding. */
  vector: Float32Array;
}

/** The persisted form of one document — what IndexedDB holds across restarts. */
export interface StoredKnowledgeDoc {
  id: string;
  kind: KnowledgeKind;
  title?: string;
  uri?: string;
  metadata: Record<string, MetadataValue>;
  updatedAt: number;
  version: number;
  contentHash: string;
  /** Embedder fingerprint the vectors were made with. */
  fingerprint: string;
  chunks: StoredChunk[];
}

export interface KnowledgeHit {
  chunkId: string;
  text: string;
  score: number;
  source: SourceReference;
  metadata: Record<string, MetadataValue>;
}

/** Reranking hook: receives the fused candidates, returns them reordered/filtered. */
export type RerankHook = (query: string, hits: KnowledgeHit[]) => KnowledgeHit[] | Promise<KnowledgeHit[]>;

export interface RetrieveOptions {
  topK?: number;
  /** Equality filter over document metadata, or a predicate over the stored doc. */
  filter?: Record<string, MetadataValue> | ((doc: StoredKnowledgeDoc) => boolean);
  kinds?: KnowledgeKind[];
  /** Half-life recency decay over fused scores (memory `decay.ts` semantics). 0/unset = off. */
  recencyHalfLifeDays?: number;
  now?: number;
  /** Candidates taken from each of the dense and sparse rankings before fusion. Default 100. */
  candidatePool?: number;
  denseWeight?: number;
  sparseWeight?: number;
  /** RRF damping constant. Default 60 (memory `RRF_DEFAULT_K`). */
  rrfK?: number;
  rerank?: RerankHook;
}

export interface ContextOptions extends RetrieveOptions {
  /** Hard cap on the estimated tokens injected into the prompt. */
  tokenBudget: number;
}

export interface AssembledContext {
  text: string;
  tokens: number;
  citations: SourceReference[];
  hits: KnowledgeHit[];
  duplicatesRemoved: number;
  droppedForBudget: number;
}

export interface IngestResult {
  id: string;
  status: 'added' | 'updated' | 'unchanged';
  version: number;
  chunks: number;
  /** Chunks that were actually sent to the embedder (0 when unchanged). */
  embedded: number;
}

export interface RetentionPolicy {
  /** Remove documents older than this (by `updatedAt`). */
  maxAgeMs?: number;
  /** Keep at most this many documents (oldest removed first). */
  maxDocuments?: number;
  /** Kinds retention never removes (e.g. user-approved knowledge). Default `['approved']`. */
  keepKinds?: KnowledgeKind[];
  now?: number;
}

/** Persistence port; `createIndexedDbKnowledgePersistence` is the browser implementation. */
export interface KnowledgePersistence {
  load(): Promise<StoredKnowledgeDoc[]>;
  put(doc: StoredKnowledgeDoc): Promise<void>;
  delete(id: string): Promise<void>;
}
