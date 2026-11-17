/**
 * Phase 1 — Local CPU Inference Engine: environment capability probe.
 *
 * Best-effort detection of what the current browser can run. SharedArrayBuffer
 * and cross-origin isolation are OPTIONAL — the runtime must work without
 * them — so these are reported, never assumed. The individual probes live in
 * `shared/hardwareProbe.ts` (the one home shared with the adaptive controller
 * and the memory manager); this module only assembles the report.
 */

import {
  detectCrossOriginIsolated,
  detectSharedArrayBuffer,
  detectWasm,
  detectWasmSimd,
  detectWebGpu,
} from '../shared/hardwareProbe.js';
import type { BackendKind, RuntimeCapabilities } from './types.js';

/** Shared wasm / wasm-SIMD detection for backend probes (onnx, wllama). */
export function detectBackendEnv(): { wasm: boolean; wasmSimd: boolean } {
  const wasm = detectWasm();
  return { wasm, wasmSimd: wasm && detectWasmSimd() };
}

export function probeRuntimeCapabilities(backends: InferenceBackendLike[] = []): RuntimeCapabilities {
  const { wasm, wasmSimd } = detectBackendEnv();
  const webgpu = detectWebGpu();
  return {
    wasm,
    wasmSimd,
    webgpu,
    crossOriginIsolated: detectCrossOriginIsolated(),
    sharedArrayBuffer: detectSharedArrayBuffer(),
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
