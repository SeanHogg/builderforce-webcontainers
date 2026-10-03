import { createEsbuildTransformer, type Transformer } from '@seanhogg/builderforce-webcontainers-core';

export interface EsbuildWasmOptions {
  /** Where to fetch esbuild.wasm. Defaults to jsDelivr at the installed version. */
  wasmURL?: string;
}

let ready: Promise<Transformer> | undefined;

/**
 * The default compiler: esbuild compiled to WebAssembly, run off the main thread.
 * esbuild may be initialised once per page, so the transformer is shared by every
 * runtime booted on it (the options of the first call win).
 */
export function createEsbuildWasmTransformer(options: EsbuildWasmOptions = {}): Promise<Transformer> {
  ready ??= (async () => {
    const esbuild = await import('esbuild-wasm');
    const wasmURL = options.wasmURL ?? `https://cdn.jsdelivr.net/npm/esbuild-wasm@${esbuild.version}/esbuild.wasm`;
    await esbuild.initialize({ wasmURL, worker: true });
    return createEsbuildTransformer(esbuild);
  })().catch((error: unknown) => {
    ready = undefined; // let a later call retry (a transient network failure fetching the wasm)
    throw error;
  });
  return ready;
}
