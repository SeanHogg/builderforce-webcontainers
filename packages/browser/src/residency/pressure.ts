/**
 * Phase 3 — memory pressure detection and dynamic workspace allocation.
 *
 * Pressure is a fact derived from used bytes vs the hard budget (and optional
 * RAM / storage / VRAM hints). The workspace is a slice of that budget the
 * manager grows when there is headroom and shrinks when pressure is on, so a
 * sustained workload stays inside the configured byte cap.
 *
 * Pure: no I/O, no inference, no decision about when to run.
 */

import type { MemoryPressure } from './types.js';

export interface PressureInput {
  usedBytes: number;
  byteBudget: number;
  /** Utilization at or above which the system is pressured. */
  pressureThreshold: number;
  /** Watermark utilization eviction aims for. */
  targetWatermark: number;
  ramBytes: number;
  vramBytes: number;
  storageQuotaBytes: number;
}

/** Detect pressure against the hard budget. Never throws. */
export function detectPressure(input: PressureInput): MemoryPressure {
  const budget = input.byteBudget > 0 ? input.byteBudget : 1;
  const used = Math.max(0, input.usedBytes);
  const utilization = used / budget;
  const threshold = clamp01(input.pressureThreshold);
  const watermark = Math.min(threshold, clamp01(input.targetWatermark));
  const pressured = utilization >= threshold;
  const targetBytes = watermark * budget;
  const reclaimBytes = pressured ? Math.max(0, Math.ceil(used - targetBytes)) : 0;
  return {
    utilization,
    pressured,
    reclaimBytes,
    vramBytes: Math.max(0, input.vramBytes),
    ramBytes: Math.max(0, input.ramBytes),
    storageQuotaBytes: Math.max(0, input.storageQuotaBytes),
  };
}

export interface WorkspaceBounds {
  minBytes: number;
  maxBytes: number;
}

export interface WorkspaceDecision {
  /** New workspace size in bytes, always inside [min, max] and the residual budget. */
  nextBytes: number;
  /** Signed delta from `currentBytes`. Positive = grow, negative = shrink. */
  deltaBytes: number;
  reason: string;
}

/**
 * Decide the next workspace size.
 *
 * - Under pressure: shrink toward `minBytes` by at least the reclaim request,
 *   and never exceed the residual budget (`byteBudget - usedBytes`).
 * - With headroom and a hit: grow by `growStepBytes` up to `maxBytes`, still
 *   capped by the residual budget so the workspace cannot push the total over
 *   the hard cap.
 * - Otherwise hold.
 */
export function planWorkspace(input: {
  currentBytes: number;
  bounds: WorkspaceBounds;
  pressure: MemoryPressure;
  byteBudget: number;
  usedBytes: number;
  /** True when the caller just hit, which is the signal to grow. */
  onHit: boolean;
  growStepBytes?: number;
}): WorkspaceDecision {
  const minBytes = Math.max(0, input.bounds.minBytes);
  const maxBytes = Math.max(minBytes, input.bounds.maxBytes);
  const current = clamp(input.currentBytes, minBytes, maxBytes);
  const residual = Math.max(0, input.byteBudget - Math.max(0, input.usedBytes));
  const ceiling = Math.min(maxBytes, current + residual);

  if (input.pressure.pressured) {
    const shrinkBy = Math.max(input.pressure.reclaimBytes, Math.ceil((current - minBytes) / 2));
    const next = clamp(current - shrinkBy, minBytes, ceiling);
    return {
      nextBytes: next,
      deltaBytes: next - current,
      reason: next < current
        ? `pressure at ${(input.pressure.utilization * 100).toFixed(1)}% — shrink workspace by ${current - next} bytes`
        : 'pressure but workspace already at its floor',
    };
  }

  if (input.onHit && current < ceiling) {
    const step = input.growStepBytes && input.growStepBytes > 0 ? input.growStepBytes : Math.max(1, Math.ceil((maxBytes - minBytes) / 8));
    const next = clamp(current + step, minBytes, ceiling);
    return {
      nextBytes: next,
      deltaBytes: next - current,
      reason: next > current
        ? `headroom — grow workspace by ${next - current} bytes`
        : 'workspace already at its ceiling',
    };
  }

  return { nextBytes: current, deltaBytes: 0, reason: 'workspace held' };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
