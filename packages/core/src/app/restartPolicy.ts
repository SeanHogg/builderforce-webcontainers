/**
 * Whether a service whose process exited on its own starts again, and after how
 * long. Pure: the orchestrator asks, then acts.
 */
import type { ReadinessKind, RestartPolicy } from './spec.js';

export interface RestartLimits {
  /** Restarts in a row before the service stays failed. Default 5. */
  maxRestarts?: number;
  /** Delay before the first restart; doubles each time. Default 250ms. */
  backoffMs?: number;
  /** Ceiling for the delay. Default 5000ms. */
  maxBackoffMs?: number;
}

export type RestartDecision = { restart: true; delayMs: number } | { restart: false; reason: 'policy' | 'completed' | 'limit' };

export const DEFAULT_RESTART_LIMITS: Required<RestartLimits> = { maxRestarts: 5, backoffMs: 250, maxBackoffMs: 5000 };

/**
 * @param attempt restarts already made in a row (0 for the first exit).
 * A one-off service (`exit-zero` readiness) that exits 0 has finished: it never restarts.
 */
export function restartDecision(policy: RestartPolicy, readiness: ReadinessKind, exitCode: number, attempt: number, limits: RestartLimits = {}): RestartDecision {
  const { maxRestarts, backoffMs, maxBackoffMs } = { ...DEFAULT_RESTART_LIMITS, ...limits };
  if (readiness === 'exit-zero' && exitCode === 0) return { restart: false, reason: 'completed' };
  const wanted = policy === 'always' || (policy === 'on-failure' && exitCode !== 0);
  if (!wanted) return { restart: false, reason: 'policy' };
  if (attempt >= maxRestarts) return { restart: false, reason: 'limit' };
  return { restart: true, delayMs: Math.min(maxBackoffMs, backoffMs * 2 ** attempt) };
}
