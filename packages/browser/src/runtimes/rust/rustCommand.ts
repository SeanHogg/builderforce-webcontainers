/**
 * The Rust runtime's command lines: what runs, and what is declined with the
 * reason. The runtime runs prebuilt wasm32-wasip1 modules — a path to a
 * `.wasm` (`./target/wasm32-wasip1/release/api.wasm`) or `wasmtime [run]
 * [--env K=V] [--dir D] module.wasm args…`. Compiling is not offered: the
 * in-browser rustc gate has not passed (README "Rust"), so `cargo`, `rustc`
 * and `rustup` decline, pointing at the prebuilt path.
 */
const TOOLCHAIN = /^(?:cargo|rustc|rustup)(?:\.exe)?$/;
const WASMTIME = /^wasmtime(?:\.exe)?$/;
const MODULE = /\.wasm$/;

const basename = (command: string) => command.replace(/\\/g, '/').split('/').pop() ?? command;

/** Every command the Rust runtime takes, as one RegExp source over a base name — what Node processes hand to the page (`foreignCommands`). */
export const RUST_COMMAND_PATTERN = `^(?:(?:cargo|rustc|rustup|wasmtime)(?:\\.exe)?|.+\\.wasm)$`;
const RUST_COMMAND = new RegExp(RUST_COMMAND_PATTERN);

/** Whether the Rust runtime (not Node) runs `command`. */
export function isRustCommand(command: string): boolean {
  return RUST_COMMAND.test(basename(command));
}

/**
 * The in-browser compile gate (PRD 31 §W9 phase 6d). Failed: rustc runs in a
 * browser only as a wasm32-wasip1-threads build (shared memory, so
 * SharedArrayBuffer and cross-origin isolation), and needs a ~96 MiB sysroot
 * plus a wasm linker beside a ~184 MiB compiler. Until it passes, services
 * arrive prebuilt.
 */
export const RUST_COMPILE_GATE = { passed: false } as const;

/** What the runtime runs, as one sentence for decline reasons. */
export const RUST_PROFILE = 'prebuilt wasm32-wasip1 modules: WASI commands (`_start`) and HTTP services on the bfwc ABI (an axum Router served with the bfwc-wasi crate)';

export const PREBUILT_HINT = 'build it outside the browser with `cargo build --release --target wasm32-wasip1` and run `./target/wasm32-wasip1/release/<name>.wasm`';

export interface RustInvocation {
  /** The module, as given (relative to the working directory). */
  module: string;
  args: string[];
  /** Variables set for the module (`wasmtime --env K=V`), over the inherited ones. */
  env: Record<string, string>;
  /** Variables taken from the process's environment: all of them (run by path), or the ones `wasmtime --env NAME` names. */
  inherit: 'all' | string[];
  /** `wasmtime --dir HOST[::GUEST]` preopens; absent: the whole project at `/` and the working directory at `.`. */
  dirs?: Array<{ host: string; guest: string }>;
}

export type RustCommandParse = { ok: true; invocation: RustInvocation } | { ok: false; reason: string };

const fail = (reason: string): RustCommandParse => ({ ok: false, reason });

/** Parse `command args…`. */
export function parseRustCommand(command: string, args: readonly string[]): RustCommandParse {
  const name = basename(command);
  if (TOOLCHAIN.test(name)) {
    return fail(`\`${[name.replace(/\.exe$/, ''), ...args].join(' ')}\` needs a Rust compiler, and in-browser compilation is not available (the in-browser rustc gate has not passed). This runtime runs ${RUST_PROFILE}: ${PREBUILT_HINT}.`);
  }
  if (MODULE.test(name) && !WASMTIME.test(name)) return { ok: true, invocation: { module: command, args: [...args], env: {}, inherit: 'all' } };
  if (!WASMTIME.test(name)) return fail(`"${command}" is not a Rust runtime command.`);
  return parseWasmtime(args);
}

/** `wasmtime [run] [--env K=V | --env K] [--dir HOST[::GUEST]] module args…`: as wasmtime, the module sees only what the options give it. */
function parseWasmtime(args: readonly string[]): RustCommandParse {
  let i = 0;
  if (args[0] === 'run') i = 1;
  else if (args[0] === 'serve') return fail('`wasmtime serve` runs wasi:http components (WASI preview 2); this runtime runs preview1 modules — serve an axum Router with the bfwc-wasi crate instead.');
  else if (args[0] && !args[0].startsWith('-') && !MODULE.test(args[0])) return fail(`\`wasmtime ${args[0]}\` is not supported: only \`wasmtime run\`.`);
  const env: Record<string, string> = {};
  const inherit: string[] = [];
  const dirs: Array<{ host: string; guest: string }> = [];
  const done = (module: string, rest: readonly string[]): RustCommandParse => ({ ok: true, invocation: { module, args: [...rest], env, inherit, dirs } });
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return done(arg, args.slice(i + 1));
    if (arg === '--') {
      const module = args[i + 1];
      return module ? done(module, args.slice(i + 2)) : fail('wasmtime: no module to run.');
    }
    const [flag, inline] = arg.includes('=') && arg.startsWith('--') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag !== '--env' && flag !== '--dir') return fail(`wasmtime: option ${flag} is not supported (supported: --env, --dir).`);
    const value = inline ?? args[++i];
    if (!value) return fail(`wasmtime: ${flag} needs a value.`);
    if (flag === '--env') {
      const at = value.indexOf('=');
      if (at > 0) env[value.slice(0, at)] = value.slice(at + 1);
      else inherit.push(value); // `--env NAME`: the process's value, as wasmtime does
    } else {
      const split = value.indexOf('::');
      dirs.push(split > 0 ? { host: value.slice(0, split), guest: value.slice(split + 2) } : { host: value, guest: value });
    }
  }
  return fail('wasmtime: no module to run.');
}
