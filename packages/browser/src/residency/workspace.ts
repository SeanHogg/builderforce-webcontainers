/**
 * Phase 3 — the residency manager's dynamic workspace.
 *
 * The workspace is charged against the hard byte budget. It grows on hits
 * while headroom remains and shrinks under pressure (the plan comes from
 * `planWorkspace`), always inside [min, max] and never so far that residents
 * plus workspace would cross the budget.
 */

import { planWorkspace, type WorkspaceBounds } from './pressure.js';
import type { MemoryPressure, ResidencyEvent } from './types.js';

export interface WorkspaceControllerOptions {
  bounds: WorkspaceBounds;
  byteBudget: number;
  initialBytes?: number;
}

/** A workspace change, ready for the manager's event log. */
export type WorkspaceChange = Omit<ResidencyEvent, 'at' | 'id'> & { kind: 'workspace-grow' | 'workspace-shrink' };

export interface WorkspaceController {
  /** Bytes currently allocated to the workspace. */
  bytes(): number;
  /**
   * Re-plan after a hit (`onHit`) or a pressure reading. `residentBytes` is
   * what the residents alone hold. Returns the change applied, if any.
   */
  apply(input: { onHit: boolean; pressure: MemoryPressure; residentBytes: number }): WorkspaceChange | undefined;
}

export function createWorkspaceController(options: WorkspaceControllerOptions): WorkspaceController {
  const { bounds, byteBudget } = options;
  const active = bounds.maxBytes > 0 || bounds.minBytes > 0;

  function clamp(bytes: number): number {
    if (!active) return 0;
    // Charged against the hard budget, so it can never start (or grow) past
    // it — even if the caller asked for a larger floor.
    const cap = Math.min(bounds.maxBytes, byteBudget);
    const floor = Math.min(bounds.minBytes, cap);
    const value = Number.isFinite(bytes) ? bytes : floor;
    return Math.min(cap, Math.max(floor, value));
  }

  let current = clamp(options.initialBytes ?? bounds.minBytes);

  return {
    bytes: () => current,
    apply({ onHit, pressure, residentBytes }) {
      if (!active) return undefined;
      const decision = planWorkspace({
        currentBytes: current,
        bounds,
        pressure,
        byteBudget,
        usedBytes: residentBytes + current,
        onHit,
      });
      if (decision.deltaBytes === 0) return undefined;
      const next = clamp(decision.nextBytes);
      if (next === current) return undefined;
      // Never let a workspace change push the total over the hard budget.
      if (residentBytes + next > byteBudget) return undefined;
      const delta = next - current;
      current = next;
      return {
        kind: delta > 0 ? 'workspace-grow' : 'workspace-shrink',
        bytes: Math.abs(delta),
        reason: decision.reason,
      };
    },
  };
}
