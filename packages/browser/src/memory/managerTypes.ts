/**
 * Phase 3 — the residency manager's public surface. Re-exported from
 * `manager.ts`, which stays the entry file; kept here so the implementation
 * file holds only behaviour.
 */

import type { StorageSink } from './storageSink.js';
import type {
  AdmitOptions,
  LookupResult,
  MemoryManagerConfig,
  MemoryPressure,
  ResidencyEvent,
  ResidencyStats,
  ResidentEntry,
  TrackedEntry,
} from './types.js';

export interface MemoryManager {
  /** Admit an entry, evicting or spilling as needed to honor the hard budget. */
  admit(entry: ResidentEntry, options?: AdmitOptions): Promise<AdmitResult>;
  /** Touch an entry. A hit updates recency and frequency and may grow the workspace. */
  get(id: string): LookupResult;
  /** hits / (hits + misses). 0 before the first lookup. */
  hitRate(): number;
  /** Reload a spilled entry back into RAM, charging the budget. */
  reload(id: string): Promise<LookupResult>;
  /** Pin an entry so eviction cannot drop it. */
  pin(id: string): boolean;
  /** Release a pin. */
  unpin(id: string): boolean;
  /** Drop one entry. Returns true if it was resident or spilled. */
  release(id: string): Promise<boolean>;
  /** Current pressure reading. */
  pressure(): MemoryPressure;
  /** Aggregate counters, including `hitRate`. */
  stats(): ResidencyStats;
  /** Explainable event log, oldest first, bounded by `eventLogLimit`. */
  events(): readonly ResidencyEvent[];
  /** Ids currently charged against the budget. */
  residentIds(): string[];
  /** Snapshot of one resident, for tests asserting eviction did not corrupt it. */
  peek(id: string): TrackedEntry | undefined;
}

export interface AdmitResult {
  /** True when the entry is now charged against the RAM/VRAM budget. */
  admitted: boolean;
  /** True when the incoming entry was spilled to browser storage instead. */
  spilled: boolean;
  /** True when a same-id resident was replaced. */
  replaced: boolean;
  /** Entries evicted to make room, oldest-evicted first. Snapshots, not live refs. */
  evicted: TrackedEntry[];
  reason: string;
}

export interface MemoryManagerOptions extends MemoryManagerConfig {
  /** Spill sink. Required for storage residency; omit for a RAM-only manager. */
  storage?: StorageSink;
}
