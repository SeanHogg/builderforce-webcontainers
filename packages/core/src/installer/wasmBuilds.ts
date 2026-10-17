/**
 * Native binaries → the same projects' own WebAssembly builds, in two shapes:
 *
 * - A twin package (`WASM_BUILDS`), installed under the original name: code that
 *   requires `esbuild` gets `esbuild-wasm` at the same version, with the same
 *   JavaScript API. Vite, Nuxt, SvelteKit, tsx and tsup all reach for these.
 *   Data, not branches: another tool with an official wasm twin is one more row.
 * - A napi-rs `-wasm32-wasi` binding (`napiWasmSibling`), added beside the
 *   per-platform ones the package lists.
 */
import type { ParsedSpec } from './spec.js';

const WASM_BUILDS: Readonly<Record<string, string>> = {
  esbuild: 'esbuild-wasm',
  rollup: '@rollup/wasm-node',
};

/** A napi-rs per-platform binding name: `@oxc-parser/binding-linux-x64-gnu`, `lightningcss-darwin-arm64`. */
const NAPI_PLATFORM = /-(?:darwin|linux|win32|android|freebsd|openharmony|sunos|aix)-[a-z0-9_-]+$/;

/**
 * napi-rs packages list a binding per platform as optional dependencies, none of
 * which fits here; most also publish a `-wasm32-wasi` sibling they look for next
 * but do not list (oxc-parser, rolldown, @tailwindcss/oxide). This names that
 * sibling, at the bindings' range, so it installs as one more optional dependency
 * (absent from the registry → skipped like any optional miss).
 */
export function napiWasmSibling(optional: Readonly<Record<string, string>> | undefined): [name: string, range: string] | undefined {
  const bindings = Object.entries(optional ?? {}).filter(([name]) => NAPI_PLATFORM.test(name));
  if (bindings.length < 2) return undefined;
  const [first, range] = bindings[0]!;
  const sibling = first.replace(NAPI_PLATFORM, '-wasm32-wasi');
  return optional![sibling] || bindings.some(([name]) => name.replace(NAPI_PLATFORM, '') !== first.replace(NAPI_PLATFORM, '')) ? undefined : [sibling, range];
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
