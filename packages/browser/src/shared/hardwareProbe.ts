/**
 * The ONE home for environment hardware/feature probes shared by the inference
 * worker, the capability report, the adaptive controller and the memory
 * manager. Every probe is best-effort and never throws: these are facts the
 * planners weigh, not gates. When a probe is inconclusive it reports the
 * conservative answer (false / undefined) rather than guessing.
 */

/**
 * Minimal WASM module whose single function body is
 * `i32.const 0; i8x16.splat; drop; end` — `65,0` = i32.const 0, `253,15`
 * (`0xFD 0x0F`) = i8x16.splat (i32 -> v128), `26` = drop, `11` = end. It
 * validates only on engines that accept SIMD opcodes, which is exactly the
 * feature being detected. 29 bytes total.
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0,
  65, 0, 253, 15, 26, 11,
]);

/** True when WebAssembly exists in this realm. */
export function detectWasm(): boolean {
  return typeof WebAssembly !== 'undefined';
}

/** True when the engine validates a module using a WASM SIMD opcode. */
export function detectWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') return false;
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** True when `navigator.gpu` is present (WebGPU exposed; an adapter may still be unavailable). */
export function detectWebGpu(): boolean {
  const nav = (globalThis as { navigator?: { gpu?: unknown } }).navigator;
  return typeof nav !== 'undefined' && nav !== null && 'gpu' in nav && nav.gpu != null;
}

/** True when SharedArrayBuffer is constructible in this realm (optional fast path). */
export function detectSharedArrayBuffer(): boolean {
  return typeof (globalThis as { SharedArrayBuffer?: unknown }).SharedArrayBuffer !== 'undefined';
}

/** True when the page/worker is cross-origin isolated (never required by this runtime). */
export function detectCrossOriginIsolated(): boolean {
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** `navigator.hardwareConcurrency`, or undefined when unreported. */
export function probeHardwareConcurrency(): number | undefined {
  const cores = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
  return typeof cores === 'number' && cores > 0 ? cores : undefined;
}

const GIB = 1024 * 1024 * 1024;

/**
 * `navigator.deviceMemory` (GiB, coarse and privacy-bucketed) in bytes, or
 * undefined when the browser does not report it. Callers pick their own
 * fallback.
 */
export function probeDeviceMemoryBytes(): number | undefined {
  const deviceMemory = (globalThis as { navigator?: { deviceMemory?: number } }).navigator?.deviceMemory;
  return typeof deviceMemory === 'number' && deviceMemory > 0 ? deviceMemory * GIB : undefined;
}
