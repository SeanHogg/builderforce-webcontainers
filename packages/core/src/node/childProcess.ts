/**
 * `child_process` over the system's `spawn`: every "process" is another program
 * of this runtime (node, npm, the shell and its commands). There are no native
 * executables, so spawning one fails with ENOENT exactly as a missing binary
 * would. Synchronous variants cannot block a browser thread on another one, so
 * they throw a clear error instead of hanging.
 */
import { EventEmitterBase } from './events.js';
import { Readable } from './stream/readable.js';
import { Writable } from './stream/writable.js';
import type { EventLoop } from './loop.js';
import type { ChildHandle, StdioChunk, System } from '../system/types.js';
import { Buffer } from './buffer.js';
import type { IpcEndpoint } from '../system/ipc.js';
import { queueCallback } from './processExit.js';

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  stdio?: unknown;
  signal?: AbortSignal;
  encoding?: string;
  maxBuffer?: number;
  /** `fork`: open a message channel (`child.send` ↔ `process.send`). */
  ipc?: boolean;
  /** `fork`: pipe the child's stdout/stderr to `child.stdout`/`stderr` instead of the parent's. */
  silent?: boolean;
  /** Keep running after this process exits (otherwise it is killed with it). */
  detached?: boolean;
}

export interface ChildProcessDeps {
  system: System;
  loop: EventLoop;
  cwd(): string;
  env(): Record<string, string | undefined>;
  /** Parent's stdio for `stdio: 'inherit'`. */
  stdout(chunk: StdioChunk): void;
  stderr(chunk: StdioChunk): void;
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

class ChildProcess extends EventEmitterBase {
  pid?: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  spawnfile: string;
  spawnargs: string[];
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  stdio: [Writable, Readable, Readable];
  private handle?: ChildHandle;
  private ipc?: IpcEndpoint;
  /** Lets go of the parent's event loop; undefined once released (exit, or `unref()`). */
  private release?: () => void;
  private exited = false;
  private readonly hold: () => () => void;

  constructor(deps: ChildProcessDeps, command: string, args: string[], options: SpawnOptions) {
    super();
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk: Uint8Array | string, _enc: string, cb: () => void) => {
        this.handle?.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk)); // bytes stay bytes
        cb();
      },
      final: (cb: () => void) => {
        this.handle?.closeStdin();
        cb();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];
    const inherit = options.stdio === 'inherit' || (Array.isArray(options.stdio) && options.stdio[1] === 'inherit');

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(options.env ?? deps.env())) if (v !== undefined) env[k] = String(v);
    const [file, argv] = options.shell ? ['bfsh', ['-c', [command, ...args].join(' ')]] : [command, args];
    this.hold = () => deps.loop.hold();
    this.release = this.hold();
    try {
      this.handle = deps.system.spawn(file, argv, { cwd: options.cwd ?? deps.cwd(), env, ipc: options.ipc, detached: options.detached });
    } catch (error) {
      this.unref();
      const code = (error as { code?: string }).code ?? 'ENOENT';
      const failure = Object.assign(new Error(`spawn ${command} ${code}`), { code, errno: -2, syscall: `spawn ${command}`, path: command, spawnargs: args });
      queueCallback(() => {
        this.emit('error', failure);
        this.emit('close', -2, null);
      });
      return;
    }
    this.pid = this.handle.pid;
    const ipc = this.handle.ipc;
    if (ipc) {
      this.ipc = ipc;
      this.connected = true;
      ipc.onMessage((message) => deps.loop._run(() => this.emit('message', message, undefined)));
      ipc.onDisconnect(() => {
        this.connected = false;
        deps.loop._run(() => this.emit('disconnect'));
      });
    }
    // Piped output arrives as Buffers, as in Node.
    this.handle.onStdout((chunk) => (inherit ? deps.stdout(chunk) : this.stdout.push(Buffer.from(chunk))));
    this.handle.onStderr((chunk) => (inherit ? deps.stderr(chunk) : this.stderr.push(Buffer.from(chunk))));
    options.signal?.addEventListener('abort', () => this.kill());
    queueCallback(() => this.emit('spawn'));
    void this.handle.exit.then((code) => {
      this.exited = true;
      this.exitCode = this.killed ? null : code;
      this.stdout.push(null);
      this.stderr.push(null);
      deps.loop._run(() => {
        this.emit('exit', this.exitCode, this.signalCode);
        this.emit('close', this.exitCode, this.signalCode);
      });
      this.unref();
    });
  }

  kill(signal = 'SIGTERM'): boolean {
    if (!this.handle || this.exitCode !== null) return false;
    this.killed = true;
    this.signalCode = signal;
    this.handle.kill(signal);
    return true;
  }

  send(message: unknown, ...rest: unknown[]): boolean {
    const callback = rest.find((arg): arg is (error: Error | null) => void => typeof arg === 'function');
    const fail = (error: Error) => {
      if (callback) queueCallback(() => callback(error));
      else queueCallback(() => this.emit('error', error));
      return false;
    };
    if (!this.ipc) return fail(Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' }));
    try {
      this.ipc.send(message);
    } catch (error) {
      return fail(error as Error);
    }
    if (callback) queueCallback(() => callback(null));
    return true;
  }
  disconnect(): void {
    this.ipc?.disconnect();
  }
  /** A running child keeps the parent alive until `unref()` (then `ref()` to hold it again). */
  ref(): void {
    if (!this.release && this.handle && !this.exited) this.release = this.hold();
  }
  unref(): void {
    this.release?.();
    this.release = undefined;
  }
}

type ExecCallback = (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void;

function collect(child: ChildProcess, command: string, callback?: ExecCallback): ChildProcess {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: unknown) => (stdout += String(c)));
  child.stderr.on('data', (c: unknown) => (stderr += String(c)));
  child.on('error', (error: Error) => callback?.(error, stdout, stderr));
  child.on('close', (code: number | null, signal: string | null) => {
    if (code === -2) return; // already reported through 'error'
    const error = code === 0 ? null : Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { code: code ?? undefined, killed: child.killed, signal, cmd: command });
    callback?.(error as (Error & { code?: number }) | null, stdout, stderr);
  });
  return child;
}

const noSync = (name: string) => () => {
  throw Object.assign(new Error(`child_process.${name} is not supported in the browser runtime (a synchronous child would block the thread it needs). Use the async form.`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};

export function createChildProcessModule(deps: ChildProcessDeps): Record<string, unknown> {
  const spawn = (command: string, args?: string[] | SpawnOptions, options?: SpawnOptions) => {
    if (!Array.isArray(args)) [options, args] = [args, []];
    return new ChildProcess(deps, command, args.map(String), options ?? {});
  };
  return {
    spawn,
    exec(command: string, options?: SpawnOptions | ExecCallback, callback?: ExecCallback) {
      if (typeof options === 'function') [callback, options] = [options, {}];
      return collect(new ChildProcess(deps, command, [], { ...options, shell: true }), command, callback);
    },
    execFile(file: string, args?: string[] | SpawnOptions | ExecCallback, options?: SpawnOptions | ExecCallback, callback?: ExecCallback) {
      if (typeof args === 'function') [callback, args, options] = [args, [], {}];
      else if (!Array.isArray(args)) [callback, options, args] = [options as ExecCallback, args, []];
      if (typeof options === 'function') [callback, options] = [options, {}];
      return collect(new ChildProcess(deps, file, args, options ?? {}), [file, ...args].map(quote).join(' '), callback);
    },
    fork(modulePath: string, args?: string[] | SpawnOptions, options?: SpawnOptions & { execArgv?: string[] }) {
      if (!Array.isArray(args)) [options, args] = [args, []];
      const opts = options ?? {};
      // A forked child shares the parent's stdout/stderr unless `silent`, as in Node.
      const stdio = opts.stdio ?? (opts.silent ? 'pipe' : 'inherit');
      return new ChildProcess(deps, 'node', [...(opts.execArgv ?? []), modulePath, ...args.map(String)], { ...opts, stdio, ipc: true });
    },
    execSync: noSync('execSync'),
    execFileSync: noSync('execFileSync'),
    spawnSync: noSync('spawnSync'),
    ChildProcess,
  };
}
