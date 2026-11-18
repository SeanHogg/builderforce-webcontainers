/**
 * What a prebuilt module is, read from its bytes: a core wasm module (the
 * runtime runs these on its preview1 WASI host) or a component (WASI preview
 * 2, which it declines), and — once compiled — whether it is a WASI command
 * (`_start`) or an HTTP service on the bfwc ABI (the bfwc-wasi crate's exports).
 */

/** A core module's preamble is `\0asm` + version 1; a component's is `\0asm` + version 0x0d with layer 1. */
export type WasmHeader = 'module' | 'component' | 'not-wasm';

export function wasmHeader(bytes: Uint8Array): WasmHeader {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return 'not-wasm';
  if (bytes[4] === 0x01 && bytes[5] === 0x00 && bytes[6] === 0x00 && bytes[7] === 0x00) return 'module';
  if (bytes[6] === 0x01 && bytes[7] === 0x00) return 'component';
  return 'not-wasm';
}

/** Why a header cannot run, or undefined when it is a core module. */
export function headerProblem(path: string, header: WasmHeader): string | undefined {
  if (header === 'not-wasm') return `${path} is not a WebAssembly module.`;
  if (header === 'component') return `${path} is a WebAssembly component (WASI preview 2, wasm32-wasip2); this runtime runs preview1 core modules — build for wasm32-wasip1.`;
  return undefined;
}

/** The service ABI this runtime speaks: a module's `bfwc_abi_version()` must answer it (rust-fixtures/bfwc-wasi `ABI_VERSION`). */
export const BFWC_ABI_VERSION = 1;

/** The service ABI's exports (rust-fixtures/bfwc-wasi). */
export const SERVICE_EXPORTS = ['memory', 'bfwc_abi_version', 'bfwc_start', 'bfwc_alloc', 'bfwc_request', 'bfwc_poll'] as const;

/** The import modules the runtime provides; a module's other imports are stubbed, and fail only if called. */
export const PROVIDED_IMPORTS: ReadonlySet<string> = new Set(['wasi_snapshot_preview1', 'bfwc']);

/** Functions the module imports from a provided module that the provider lacks (`bfwc.foo`), so it is declined before it links. */
export function missingImports(module: WebAssembly.Module, provided: Readonly<Record<string, Readonly<Record<string, unknown>>>>): string[] {
  return WebAssembly.Module.imports(module)
    .filter((entry) => PROVIDED_IMPORTS.has(entry.module) && !(Object.hasOwn(provided, entry.module) && Object.hasOwn(provided[entry.module]!, entry.name)))
    .map((entry) => `${entry.module}.${entry.name}`);
}

export type ModuleShape = { ok: true; kind: 'command' | 'service' } | { ok: false; reason: string };

export function moduleShape(path: string, module: WebAssembly.Module): ModuleShape {
  const exports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  const foreign = WebAssembly.Module.imports(module).find((entry) => !PROVIDED_IMPORTS.has(entry.module) && entry.kind !== 'function');
  if (foreign) return { ok: false, reason: `${path} imports a ${foreign.kind} (${foreign.module}.${foreign.name}) the runtime does not provide.` };
  if (exports.has('bfwc_start')) {
    const missing = SERVICE_EXPORTS.filter((name) => !exports.has(name));
    return missing.length ? { ok: false, reason: `${path} exports bfwc_start but not ${missing.join(', ')}: build it with the bfwc-wasi crate this package ships (ABI ${BFWC_ABI_VERSION}).` } : { ok: true, kind: 'service' };
  }
  if (exports.has('_start')) return { ok: true, kind: 'command' };
  return { ok: false, reason: `${path} exports neither _start (a WASI command) nor bfwc_start (a bfwc-wasi service).` };
}
