/**
 * Phase 7 — the learner's apply / rollback ledger.
 *
 * Records which strategy is applied per signature and the bounded history of
 * changes, so the last change can be rolled back. Recording a change never
 * mutates another module; the deltas are copied plain data.
 *
 * History is capped (`limit`, oldest dropped first): rollback reaches back at
 * most `limit` changes, and a long-running learner cannot grow without bound.
 */

import type { ConfigDeltaField, HistoryEntry } from './types.js';

export function copyDeltas(deltas: ReadonlyArray<ConfigDeltaField> | undefined): ConfigDeltaField[] {
  if (!deltas) return [];
  return deltas.map((d) => ({ field: d.field, value: d.value }));
}

export interface ChangeLedger {
  /** Strategy currently recorded as applied for `signature`. */
  active(signature: string): string | undefined;
  /** Record `strategy` as applied without a history entry (no change happened). */
  setActive(signature: string, strategy: string): void;
  /** Record a change: append history (bounded) and mark `entry.to` applied. */
  record(entry: HistoryEntry): void;
  /** Remove the last change and restore its `from`. Undefined when history is empty. */
  popLast(): HistoryEntry | undefined;
  /** Live, bounded history, oldest first. */
  history(): readonly HistoryEntry[];
}

export function createChangeLedger(limit: number): ChangeLedger {
  const cap = Math.max(1, limit);
  const applied = new Map<string, string>();
  const history: HistoryEntry[] = [];

  return {
    active: (signature) => applied.get(signature),
    setActive(signature, strategy) {
      applied.set(signature, strategy);
    },
    record(entry) {
      history.push(entry);
      if (history.length > cap) history.splice(0, history.length - cap);
      applied.set(entry.signature, entry.to);
    },
    popLast() {
      const last = history.pop();
      if (last) applied.set(last.signature, last.from);
      return last;
    },
    history: () => history,
  };
}
