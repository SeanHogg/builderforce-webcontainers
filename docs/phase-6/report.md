# Phase 6 — BuilderForce Memory Integration

**Ticket:** #6743 · **Module:** `packages/browser/src/memoryIntegration/` (separate from Phase 3 `src/residency/`)

## What was built
| File | Role |
|---|---|
| `types.ts` | `TextEmbedder` seam — the same shape as memory-engine `TextEmbedder` (`EvermindTextEmbedder`: `embed(text)→Float32Array`, `dimensions`, `fingerprint`). Plus the document, chunk, hit, citation, retention and persistence types. |
| `text.ts` | Normalisation, chunking (memory `chunkText` semantics: 1000/200 defaults, recursive separators), `tokenize`, BM25 inverted index (memory `LexicalIndex`/Okapi core, k1 1.5, b 0.75), `compareHits` order, content hash, token estimate. |
| `knowledgeMemory.ts` | `createKnowledgeMemory`. It covers the whole lifecycle: capture, normalise, chunk, embed, index, then hybrid retrieval (dense cosine + BM25, fused with RRF k=60 as in `HybridRetriever`), with metadata and kind filters, half-life recency decay (memory `decay.ts`) and a rerank hook. It also does context assembly (dedup, whitespace compression, `tokenBudget` cap, numbered citations), update, delete and `compact` (retention by age or count; `approved` documents are kept by default). |
| `persistence.ts` | IndexedDB store (same pattern as `modelCache.ts`) plus an in-memory store. |

## Matching the memory layer
- The embedder is injected, so this package has no import dependency on builderforce-memory. Vectors are stamped with the embedder fingerprint. On `load()`, a document made under a different fingerprint is reported `stale` and is never compared (the same rule as `EmbedderPort`).
- **Incremental indexing:** if a document's normalised content hash and metadata are unchanged, it is skipped. If it changed, only chunks with a new hash are re-embedded. A chunk that repeats inside one source is stored once. Each document carries a `version` that goes up when its content changes.
- Every hit carries a `SourceReference`: sourceId, version, contentHash, chunkId, chunkIndex, offset, kind, title and uri.

## Acceptance (tests/memory-integration.test.ts)
- 10,000 chunks: p95 retrieval < 500 ms (about 1 s for the whole test, including ingest).
- Recall@5 ≥ 85% on a labelled set of 20 topics against 300 distractors.
- Injected tokens ≤ 50% of the full-context baseline (the test budget is 10%); every citation resolves to a live chunk and version.
- Changing one document re-embeds only that document.
- An IndexedDB round-trip (fake-indexeddb) survives a restart; a different fingerprint is reported stale.
- Updates, deletion, retention, filters and the rerank hook are all checked.

## Notes
The dense pass is an exact scan, which is fine at 10k chunks. An ANN index (HNSW, as the memory layer has) is the next step when collections are larger.
