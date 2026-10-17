/**
 * Packages whose real build is a native binary, installed as the same project's
 * own WebAssembly build under the original name: code that requires `esbuild`
 * gets `esbuild-wasm` at the same version, with the same JavaScript API. Vite,
 * Nuxt, SvelteKit, tsx and tsup all reach for these two.
 *
 * Data, not branches: another native-only tool with an official wasm twin is one
 * more row.
 */
import type { ParsedSpec } from './spec.js';

const WASM_BUILDS: Readonly<Record<string, string>> = {
  esbuild: 'esbuild-wasm',
  rollup: '@rollup/wasm-node',
};

/**
 * The wasm twin of `spec`, when it has one and was asked for by its own name
 * (an explicit `npm:` alias is left alone). The caller falls back to `spec` when
 * the twin has no matching version: Rollup 3 is plain JavaScript and has no
 * `@rollup/wasm-node` release, and needs no substitute.
 */
export function wasmBuildOf(spec: ParsedSpec): ParsedSpec | undefined {
  const twin = spec.registryName === spec.name ? WASM_BUILDS[spec.name] : undefined;
  return twin ? { ...spec, registryName: twin } : undefined;
}
