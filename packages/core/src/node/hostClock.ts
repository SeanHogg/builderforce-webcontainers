/**
 * The host's monotonic clock, captured when the runtime loads — before any program
 * runs — as Node's own clock is native and owes nothing to `globalThis.performance`.
 *
 * Programs replace that global: Go's WebAssembly loader up to esbuild-wasm 0.21 (the
 * one Vite 5 installs) sets `globalThis.performance = { now: () => process.hrtime()… }`.
 * If `process.hrtime` read the global back, each would call the other until the stack
 * ran out. Every clock the runtime hands a program (`process.hrtime`/`uptime`/`cpuUsage`,
 * `console.time`, `os.uptime`, `perf_hooks.performance`, WASI clocks) reads this one.
 */
export const hostPerformance: Performance = globalThis.performance;

const now = hostPerformance.now.bind(hostPerformance);

/** Milliseconds on the host's monotonic clock. */
export const hostNow = (): number => now();
