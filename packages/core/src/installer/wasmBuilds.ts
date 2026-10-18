/**
 * Native binaries → the same projects' own WebAssembly builds, in two shapes:
 *
 * - A twin package (`WASM_BUILDS`), installed under the original name: code that
 *   requires `esbuild` gets `esbuild-wasm` at the same version, with the same
 *   JavaScript API. Vite, Nuxt, SvelteKit, tsx and tsup all reach for these.
 *   Data, not branches: another tool with an official wasm twin is one more row.
 * - A napi-rs WebAssembly binding (`napiWasmSiblings`), added beside the
 *   per-platform ones the package lists.
 */
import type { ParsedSpec } from './spec.js';

const WASM_BUILDS: Readonly<Record<string, string>> = {
  esbuild: 'esbuild-wasm',
  rollup: '@rollup/wasm-node',
};

/** A napi-rs per-platform binding name: `@oxc-parser/binding-linux-x64-gnu`, `lightningcss-darwin-arm64`. */
const NAPI_PLATFORM = /-(?:darwin|linux|win32|android|freebsd|openharmony|sunos|aix)-[a-z0-9_-]+$/;

/** WebAssembly binding flavors, preferred first: `wasip1` is single-threaded (no shared memory, so no cross-origin isolation); `wasi` needs threads. */
const NAPI_WASM_FLAVORS = ['-wasm32-wasip1', '-wasm32-wasi'] as const;

export interface NapiWasmSibling {
  name: string;
  range: string;
  /** Install only when this preferred flavor did not resolve. */
  fallbackFor?: string;
}

/**
 * napi-rs packages list a binding per platform as optional dependencies, none of
 * which fits here; most also publish WebAssembly siblings they look for next but do
 * not list (oxc-parser, rolldown, @tailwindcss/oxide). This names them, at the
 * bindings' range, as optional dependencies: the single-threaded `-wasm32-wasip1`
 * first, the threaded `-wasm32-wasi` only if that one is not published (a registry
 * miss is skipped like any optional one). Nothing when the package lists the single-threaded one itself; one that lists only the threaded one gets the single-threaded one added, and its own entry becomes the fallback.
 */
export function napiWasmSiblings(optional: Readonly<Record<string, string>> | undefined): NapiWasmSibling[] {
  const bindings = Object.entries(optional ?? {}).filter(([name]) => NAPI_PLATFORM.test(name));
  if (bindings.length < 2) return [];
  const [first, range] = bindings[0]!;
  const base = first.replace(NAPI_PLATFORM, '');
  if (bindings.some(([name]) => name.replace(NAPI_PLATFORM, '') !== base)) return [];
  const [preferred, fallback] = NAPI_WASM_FLAVORS.map((flavor) => base + flavor) as [string, string];
  if (optional![preferred]) return [];
  // Listing only the threaded flavor still gets the single-threaded one added; the listed entry becomes its fallback.
  return [{ name: preferred, range }, { name: fallback, range, fallbackFor: preferred }];
}

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
