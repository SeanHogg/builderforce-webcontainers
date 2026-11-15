/**
 * Phase 1 — Local CPU Inference Engine: environment capability probe.
 *
 * Best-effort detection of what the current browser can run. SharedArrayBuffer
 * and cross-origin isolation are OPTIONAL — the runtime must work without
 * them — so these are reported, never assumed. SIMD detection uses the same
 * WebAssembly.validate trick the toolchain uses elsewhere; if validation is
 * inconclusive we report false rather than guessing.
 */

import type { BackendInfo, BackendKind, RuntimeCapabilities } from './types.js';

/** 8-byte WASM module using a v128 (SIMD) operation, for feature detection. */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0,
  65, 0, 253, 15, 26, 11,
]);

function detectWasmSimd(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') return false;
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

export function probeRuntimeCapabilities(backends: InferenceBackendLike[] = []): RuntimeCapabilities {
  const g = globalThis as {
    crossOriginIsolated?: boolean;
    SharedArrayBuffer?: unknown;
    navigator?: { gpu?: unknown };
  };
  const wasm = typeof WebAssembly !== 'undefined';
  const wasmSimd = wasm && detectWasmSimd();
  const crossOriginIsolated = g.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof g.SharedArrayBuffer !== 'undefined';
  const webgpu = typeof g.navigator !== 'undefined' && 'gpu' in g.navigator;
  return {
    wasm,
    wasmSimd,
    webgpu,
    crossOriginIsolated,
    sharedArrayBuffer,
    backends: backends.map((b) => ({
      kind: b.kind as BackendKind,
      available: wasm,
      wasmSimd,
      webgpu,
    })),
  };
}

export interface InferenceBackendLike {
  kind: string;
}
