/**
 * Running one prebuilt wasm32-wasip1 module on the preview1 WASI host (core's
 * `createVfsWasi`, the host node:wasi uses) over the process's files:
 *
 * - a WASI command (`_start`) runs to completion, like `wasmtime app.wasm`;
 * - a bfwc-wasi service is checked against the ABI version, set up
 *   (`_initialize` when exported, then `bfwc_start`), must claim its port, and
 *   from then on is driven by its requests and connections (rustBridge.ts).
 *
 * Run by path, the module sees the whole project at `/`, the working directory
 * at `.` and the process's environment; under `wasmtime run`, only the `--dir`
 * preopens and `--env` variables, as wasmtime gives. A module importing a
 * `bfwc` or WASI preview1 function the runtime lacks is declined before it
 * links. Imports from other modules (a stray WASI preview 2 function a
 * dependency links but never calls) are stubbed: calling one fails the process
 * with the name. A trap ends the process with 134, as wasmtime does.
 */
import { WasiExit, createVfsWasi, resolveFrom, type StdioChunk, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { InterpreterOutcome } from '../interpreterProcess.js';
import { createRustBridge, type Dial, type RustServiceExports } from './rustBridge.js';
import type { RustInvocation } from './rustCommand.js';
import { BFWC_ABI_VERSION, PROVIDED_IMPORTS, headerProblem, missingImports, moduleShape, wasmHeader } from './rustModule.js';

/** Exit code of a trapped module (wasmtime's). */
export const TRAP_EXIT = 134;

export interface RustRunContext {
  fs: VirtualFileSystem;
  cwd: string;
  env: Record<string, string>;
  io: { stdout(data: StdioChunk): void; stderr(data: StdioChunk): void };
  dial: Dial;
  /** A served module trapped or exited after it started serving: the process ends with `code`. */
  ended(code: number): void;
}

const exited = (code: number): InterpreterOutcome => ({ kind: 'exited', code });

const describeTrap = (module: string, error: unknown) => `Error: failed to run ${module}\n\nCaused by:\n    wasm trap: ${error instanceof Error ? error.message : String(error)}\n`;

/** The exit code a guest's own `proc_exit` asked for, or the trap's. */
function endOf(module: string, error: unknown, io: RustRunContext['io']): number {
  if (error instanceof WasiExit) return error.code;
  io.stderr(describeTrap(module, error));
  return TRAP_EXIT;
}

/** Throwing stand-ins for imports from modules the runtime does not provide. No prototypes: a module named `__proto__` is just a name. */
export function stubImports(module: WebAssembly.Module): Record<string, Record<string, () => never>> {
  const stubs: Record<string, Record<string, () => never>> = Object.create(null);
  for (const entry of WebAssembly.Module.imports(module)) {
    if (PROVIDED_IMPORTS.has(entry.module) || entry.kind !== 'function') continue;
    if (!Object.hasOwn(stubs, entry.module)) stubs[entry.module] = Object.create(null);
    stubs[entry.module]![entry.name] = () => {
      throw new Error(`${entry.module}.${entry.name} is not provided by the Rust runtime (WASI preview1 only)`);
    };
  }
  return stubs;
}

/** What the module sees: the environment and preopened directories. */
function worldOf(invocation: RustInvocation, ctx: RustRunContext): { env: Record<string, string>; preopens: Record<string, string> } {
  const inherited = invocation.inherit === 'all' ? { ...ctx.env } : Object.fromEntries(invocation.inherit.flatMap((name) => (Object.hasOwn(ctx.env, name) ? [[name, ctx.env[name]!]] : [])));
  const env = { ...inherited, ...invocation.env };
  if (!invocation.dirs) return { env, preopens: { '/': '/', '.': ctx.cwd } };
  return { env, preopens: Object.fromEntries(invocation.dirs.map((dir) => [dir.guest, resolveFrom(ctx.cwd, dir.host)])) };
}

export async function runRustModule(invocation: RustInvocation, ctx: RustRunContext): Promise<InterpreterOutcome> {
  const fail = (message: string) => {
    ctx.io.stderr(`Error: ${message}\n`);
    return exited(1);
  };
  const path = resolveFrom(ctx.cwd, invocation.module);
  const contents = ctx.fs.readFile(path);
  if (contents === undefined) return fail(`failed to read ${invocation.module}: no such file (a prebuilt module is expected; build it with \`cargo build --release --target wasm32-wasip1\`).`);
  if (typeof contents === 'string') return fail(`${invocation.module} is not a WebAssembly module.`);
  const problem = headerProblem(invocation.module, wasmHeader(contents));
  if (problem) return fail(problem);
  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(contents as Uint8Array<ArrayBuffer>);
  } catch (error) {
    return fail(`failed to compile ${invocation.module}: ${(error as Error).message}`);
  }
  const shape = moduleShape(invocation.module, module);
  if (!shape.ok) return fail(shape.reason);

  const { env, preopens } = worldOf(invocation, ctx);
  const wasi = createVfsWasi({ vfs: ctx.fs, cwd: ctx.cwd, stdout: (bytes) => ctx.io.stdout(bytes.slice()), stderr: (bytes) => ctx.io.stderr(bytes.slice()), args: [invocation.module, ...invocation.args], env, preopens, returnOnExit: true });
  const bridge = createRustBridge({ dial: ctx.dial, onFault: (error) => ctx.ended(endOf(invocation.module, error, ctx.io)) });
  const missing = missingImports(module, { wasi_snapshot_preview1: wasi.wasiImport, bfwc: bridge.imports });
  if (missing.length) return fail(`${invocation.module} imports ${missing.join(', ')}, which the Rust runtime does not provide.`);
  const instance = await WebAssembly.instantiate(module, { ...stubImports(module), wasi_snapshot_preview1: wasi.wasiImport, bfwc: bridge.imports });

  if (shape.kind === 'command') {
    try {
      return exited(wasi.start(instance as never) ?? 0);
    } catch (error) {
      return exited(endOf(invocation.module, error, ctx.io));
    }
  }

  const service = instance.exports as unknown as RustServiceExports;
  const version = service.bfwc_abi_version();
  if (version !== BFWC_ABI_VERSION) return fail(`${invocation.module} was built for bfwc ABI ${version}; this runtime speaks ABI ${BFWC_ABI_VERSION} — rebuild it with the bfwc-wasi crate this package ships.`);
  let code: number;
  try {
    bridge.attach(service);
    wasi.initialize(instance as never);
    code = service.bfwc_start();
  } catch (error) {
    bridge.close();
    return exited(endOf(invocation.module, error, ctx.io));
  } finally {
    bridge.started();
  }
  const port = bridge.port;
  if (code !== 0) {
    bridge.close();
    return exited(code);
  }
  if (port === undefined) {
    bridge.close();
    return fail(`${invocation.module}: bfwc_start returned without serving — call bfwc_wasi::serve(port, router) from it.`);
  }
  bridge.schedule(); // tasks bfwc_start spawned
  return {
    kind: 'serving',
    banner: '',
    server: {
      port,
      handle: bridge.handle,
      close: async () => bridge.close(),
    },
  };
}
