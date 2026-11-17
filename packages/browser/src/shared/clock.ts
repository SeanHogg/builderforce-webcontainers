/**
 * The ONE monotonic-ish clock for measuring elapsed time: `performance.now()`
 * when the realm has it, `Date.now()` otherwise. Use it for durations only —
 * the origin differs between the two sources, so never persist the value.
 */
export function now(): number {
  const g = globalThis as { performance?: { now?(): number } };
  return g.performance?.now?.() ?? Date.now();
}
