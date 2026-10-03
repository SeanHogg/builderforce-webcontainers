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
import type { ChildHandle, System } from '../system/types.js';

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  shell?: boolean | string;
  stdio?: unknown;
  signal?: AbortSignal;
  encoding?: string;
  maxBuffer?: number;
}

export interface ChildProcessDeps {
  system: System;
  loop: EventLoop;
  cwd(): string;
  env(): Record<string, string | undefined>;
  /** Parent's stdio for `stdio: 'inherit'`. */
  stdout(chunk: string): void;
  stderr(chunk: string): void;
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

  constructor(deps: ChildProcessDeps, command: string, args: string[], options: SpawnOptions) {
    super();
    this.spawnfile = command;
    this.spawnargs = [command, ...args];
    this.stdout = new Readable({ read() {} });
    this.stderr = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk: Uint8Array | string, _enc: string, cb: () => void) => {
        this.handle?.write(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
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
    const [file, argv] = options.shell ? ['jsh', ['-c', [command, ...args].join(' ')]] : [command, args];
    const release = deps.loop.hold();
    try {
      this.handle = deps.system.spawn(file, argv, { cwd: options.cwd ?? deps.cwd(), env });
    } catch (error) {
      release();
      const code = (error as { code?: string }).code ?? 'ENOENT';
      const failure = Object.assign(new Error(`spawn ${command} ${code}`), { code, errno: -2, syscall: `spawn ${command}`, path: command, spawnargs: args });
      queueMicrotask(() => {
        this.emit('error', failure);
        this.emit('close', -2, null);
      });
      return;
    }
    this.pid = this.handle.pid;
    this.handle.onStdout((chunk) => (inherit ? deps.stdout(chunk) : this.stdout.push(chunk)));
    this.handle.onStderr((chunk) => (inherit ? deps.stderr(chunk) : this.stderr.push(chunk)));
    options.signal?.addEventListener('abort', () => this.kill());
    queueMicrotask(() => this.emit('spawn'));
    void this.handle.exit.then((code) => {
      this.exitCode = this.killed ? null : code;
      this.stdout.push(null);
      this.stderr.push(null);
      deps.loop._run(() => {
        this.emit('exit', this.exitCode, this.signalCode);
        this.emit('close', this.exitCode, this.signalCode);
      });
      release();
    });
  }

  kill(signal = 'SIGTERM'): boolean {
    if (!this.handle || this.exitCode !== null) return false;
    this.killed = true;
    this.signalCode = signal;
    this.handle.kill(signal);
    return true;
  }

  send(): boolean {
    throw Object.assign(new Error('IPC channels are not supported in the browser runtime'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  }
  disconnect(): void {}
  ref(): void {}
  unref(): void {}
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
    fork(modulePath: string, args?: string[] | SpawnOptions, options?: SpawnOptions) {
      if (!Array.isArray(args)) [options, args] = [args, []];
      return new ChildProcess(deps, 'node', [modulePath, ...args], options ?? {});
    },
    execSync: noSync('execSync'),
    execFileSync: noSync('execFileSync'),
    spawnSync: noSync('spawnSync'),
    ChildProcess,
  };
}
