import { createEsbuildBundler, createEsbuildTransformer, type Bundler, type Transformer } from '@seanhogg/builderforce-webcontainers-core';

export interface EsbuildWasmOptions {
  /** Where to fetch esbuild.wasm. Defaults to jsDelivr at the installed version. */
  wasmURL?: string;
}

type EsbuildWasm = typeof import('esbuild-wasm');

let ready: Promise<EsbuildWasm> | undefined;

/**
 * esbuild compiled to WebAssembly, run off the main thread. esbuild may be
 * initialised once per page, so the dev-server transformer and the production
 * bundler share one instance (the options of the first call win).
 */
export function loadEsbuildWasm(options: EsbuildWasmOptions = {}): Promise<EsbuildWasm> {
  ready ??= (async () => {
    const esbuild = await import('esbuild-wasm');
    const wasmURL = options.wasmURL ?? `https://cdn.jsdelivr.net/npm/esbuild-wasm@${esbuild.version}/esbuild.wasm`;
    await esbuild.initialize({ wasmURL, worker: true });
    return esbuild;
  })().catch((error: unknown) => {
    ready = undefined; // let a later call retry (a transient network failure fetching the wasm)
    throw error;
  });
  return ready;
}

/** The default compiler for the dev server. */
export async function createEsbuildWasmTransformer(options: EsbuildWasmOptions = {}): Promise<Transformer> {
  return createEsbuildTransformer(await loadEsbuildWasm(options));
}

/** The default bundler for `runtime.build()`. */
export async function createEsbuildWasmBundler(options: EsbuildWasmOptions = {}): Promise<Bundler> {
  return createEsbuildBundler(await loadEsbuildWasm(options));
}
