/**
 * Phase 3 — Hierarchical Memory & Residency Management: types.
 *
 * Owns WHERE model weights and layer components live (RAM / optional VRAM hint /
 * browser storage) and HOW they are admitted, quoted, and evicted under a hard
 * byte budget. It does not decide WHEN to run inference — that is the Adaptive
 * Heterogeneous Execution Controller in `src/adaptive/`.
 *
 * Browser-compatible only: pure TypeScript, no native code, no dependencies.
 * SharedArrayBuffer and WebGPU are optional probed facts, never gates.
 * CPU-only is the primary path: residency falls back to system RAM + IndexedDB
 * (the Phase 1 `ModelCache`) when no GPU is present.
 */

/** Where a resident entry's bytes currently live. */
export type ResidencyTier = 'ram' | 'vram' | 'storage';

/**
 * One cacheable unit: a whole model, a layer, or a component (KV head, embedding).
 * `bytes` is the footprint the budget accounts for. Payload is opaque — the
 * manager never interprets it, so eviction cannot corrupt inference state.
 */
export interface ResidentEntry {
  /** Stable id, e.g. `model:tiny-q4` or `model:tiny-q4/layer:7`. */
  id: string;
  /** Logical group the quota applies to (a model id, a component class). */
  group: string;
  /** Optional finer bucket inside the group (`layer`, `kv`, `embed`). */
  component?: string;
  /** Footprint in bytes. Must be >= 0. The hard budget counts this, not payload. */
  bytes: number;
  /** Estimated cost to reload this entry from storage or network, in ms. */
  reloadCostMs: number;
  /**
   * Estimated probability this entry is reused before the next pressure event,
   * in [0, 1]. Combined with reload cost to score eviction candidates.
   */
  reuseProbability: number;
  /** Where the bytes live. `vram` is a hint only — never required. */
  tier: ResidencyTier;
  /** Opaque payload. Retained so a hit returns the same object the caller put. */
  payload?: unknown;
  /** Optional hint that this entry is pinned and must not be evicted. */
  pinned?: boolean;
}

/** A resident entry plus the bookkeeping the strategies and stats read. */
export interface TrackedEntry extends ResidentEntry {
  /** Monotonic admission sequence (LRU recency, ARC MRU). */
  admittedAt: number;
  /** Last successful touch sequence. */
  lastUsedAt: number;
  /** Touch count since admission (LFU). */
  hits: number;
  /** ARC list membership. Absent for non-ARC strategies. */
  arcList?: 't1' | 't2' | 'b1' | 'b2';
}

/** Result of a `get`. A miss is `{ hit: false }` — never throws for absence. */
export interface LookupResult {
  hit: boolean;
  entry?: TrackedEntry;
}

/** Why an admission or eviction happened. Explainable, for audit and Phase 4. */
export type ResidencyEventKind =
  | 'admit'
  | 'hit'
  | 'miss'
  | 'evict'
  | 'pin'
  | 'unpin'
  | 'pressure'
  | 'workspace-grow'
  | 'workspace-shrink'
  | 'spill'
  | 'reload';

export interface ResidencyEvent {
  kind: ResidencyEventKind;
  /** Entry the event concerns, when there is one. */
  id?: string;
  /** Bytes freed (evict/shrink) or consumed (admit/grow). */
  bytes?: number;
  /** Human-readable reason. */
  reason: string;
  at: number;
}

/** Aggregate counters. `hitRate` is hits / (hits + misses); 0 when unused. */
export interface ResidencyStats {
  hits: number;
  misses: number;
  admissions: number;
  evictions: number;
  spills: number;
  reloads: number;
  /** Bytes currently charged against the hard budget (RAM + VRAM residents). */
  usedBytes: number;
  /** Configured hard cap. */
  byteBudget: number;
  /** Bytes of the dynamic workspace currently allocated. */
  workspaceBytes: number;
  /** Residents currently held in RAM or VRAM. */
  residentCount: number;
  /** Residents spilled to browser storage (not charged against the RAM budget). */
  spilledCount: number;
  /** Bytes retained in browser storage. Bounded by `storageBudgetBytes`. */
  spilledBytes: number;
  hitRate: number;
}

/** Pressure reading. Facts the manager acts on; callers may also observe them. */
export interface MemoryPressure {
  /** usedBytes / byteBudget, in [0, 1+] (can exceed 1 only before eviction runs). */
  utilization: number;
  /** True when utilization >= the configured pressure threshold. */
  pressured: boolean;
  /** Bytes that must be freed to get back under the target watermark. */
  reclaimBytes: number;
  /** Optional VRAM hint in bytes. 0 when no GPU was probed. */
  vramBytes: number;
  /** System RAM hint in bytes (navigator.deviceMemory when present). */
  ramBytes: number;
  /** Browser storage quota hint in bytes, when the environment reports one. */
  storageQuotaBytes: number;
}

/**
 * Pluggable eviction strategy. The manager owns the map; the strategy only
 * decides order. Strategies must be pure over the snapshot they are given so
 * they stay swappable and unit-testable without a manager.
 */
export interface EvictionStrategy {
  readonly name: 'lru' | 'lfu' | 'arc' | 'cost-aware' | (string & {});
  /**
   * Rank `candidates` (already filtered to evictable, unpinned residents)
   * from most-evictable to least. Return a new array; do not mutate inputs.
   */
  rank(candidates: readonly TrackedEntry[]): TrackedEntry[];
  /**
   * Optional hook so ARC (and similar) can record a hit/miss against its
   * ghost lists. Default strategies ignore this.
   */
  observe?(event: { kind: 'hit' | 'miss' | 'admit' | 'evict'; entry: TrackedEntry }): void;
}

/** Per-group and optional per-component byte quotas. */
export interface Quota {
  /** Group these bytes belong to (usually a model id). */
  group: string;
  /** Optional component bucket inside the group. Omit for a group-wide cap. */
  component?: string;
  /** Hard cap in bytes for this group (or group+component). */
  byteCap: number;
}

export interface MemoryManagerConfig {
  /**
   * Hard byte budget for RAM+VRAM residents. Eviction runs until
   * `usedBytes + incoming <= byteBudget`. Required — there is no implicit
   * unbounded default.
   */
  byteBudget: number;
  /** Eviction strategy. Default: cost-aware. */
  strategy?: EvictionStrategy;
  /** Per-layer / per-component quotas. Enforced on admission, before the global budget. */
  quotas?: readonly Quota[];
  /**
   * Utilization at or above which the manager reports pressure and shrinks
   * the workspace. Default 0.85.
   */
  pressureThreshold?: number;
  /**
   * After pressure eviction, utilization is brought down to this watermark.
   * Default 0.7. Must be <= pressureThreshold.
   */
  targetWatermark?: number;
  /**
   * Dynamic workspace bounds. The workspace grows on hits while headroom
   * remains and shrinks under pressure, always inside [min, max] and always
   * inside the residual byte budget.
   */
  workspace?: { minBytes: number; maxBytes: number; initialBytes?: number };
  /**
   * Optional VRAM budget hint in bytes. 0 (default) means CPU-only: no entry
   * is placed in `vram`, and the hint is reported as a fact.
   */
  vramBudgetBytes?: number;
  /** System RAM hint. Default: probed `navigator.deviceMemory`, else 4 GiB. */
  ramBytes?: number;
  /** Browser storage quota hint. Default: probed `navigator.storage.estimate`, else 0. */
  storageQuotaBytes?: number;
  /**
   * Cap on bytes retained in the browser-storage sink. Evicted RAM residents
   * spill here until this cap, then the oldest spills are dropped. Default:
   * `storageQuotaBytes` when it is set, otherwise `4 * byteBudget`. `0`
   * disables retention (a spill is not kept).
   */
  storageBudgetBytes?: number;
  /** Retain at most this many explainable events. Default 256. */
  eventLogLimit?: number;
  /** Clock for tests. Default `Date.now`. */
  now?: () => number;
}

/** Options for a single admission. */
export interface AdmitOptions {
  /**
   * When the budget cannot fit this entry even after evicting every unpinned
   * resident, spill it to browser storage instead of rejecting. Default true
   * when a storage sink is configured, false otherwise.
   */
  spill?: boolean;
  /** Pin on admission so later eviction cannot drop it. */
  pin?: boolean;
}
