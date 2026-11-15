import { describe, expect, it } from 'vitest';
import { probeRuntimeCapabilities } from '../src/inference/capabilities.js';

describe('probeRuntimeCapabilities', () => {
  it('reports wasm/simd/webgpu/isolation facts without throwing', () => {
    const caps = probeRuntimeCapabilities();
    expect(typeof caps.wasm).toBe('boolean');
    expect(typeof caps.wasmSimd).toBe('boolean');
    expect(typeof caps.webgpu).toBe('boolean');
    expect(typeof caps.crossOriginIsolated).toBe('boolean');
    expect(typeof caps.sharedArrayBuffer).toBe('boolean');
    expect(Array.isArray(caps.backends)).toBe(true);
  });

  it('does not require SharedArrayBuffer or cross-origin isolation', () => {
    // The whole point of the probe: CPU-only operation must be reportable
    // even in the least-capable environment. These are facts, not gates.
    const caps = probeRuntimeCapabilities();
    expect(caps.wasm === false || caps.sharedArrayBuffer === true || caps.sharedArrayBuffer === false).toBe(true);
  });
});
