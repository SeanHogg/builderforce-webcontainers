/**
 * The `process` object of one runtime: argv/env/cwd, `exit` (unwinds via
 * {@link ProcessExit}), `nextTick`, stdio streams wired to the program's IO
 * port, and the identity a Linux Node 20 reports — packages branch on
 * `process.platform`, `process.versions.node` and `process.stdout.isTTY`.
 */
import { EventEmitterBase } from './events.js';
import { Readable } from './stream/readable.js';
import { Writable } from './stream/writable.js';
import type { EventLoop } from './loop.js';
import type { ProgramIO } from '../system/types.js';
import type { VirtualFileSystem } from '../vfs.js';
import { join, normalizePath } from '../paths.js';
import { fsError } from './fs/stats.js';
import { format } from './inspect.js';

export const NODE_VERSION = '20.18.0';

/** Thrown by `process.exit()` to unwind user code; the runtime catches it. */
export class ProcessExit {
  constructor(readonly code: number) {}
}

let nextPid = 100;

export interface ProcessOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  fs: VirtualFileSystem;
  io: ProgramIO;
  loop: EventLoop;
  /** Called once with the exit code; the runtime tears down. */
  onExit(code: number): void;
}

class TtyWriteStream extends Writable {
  isTTY: boolean;
  fd: number;
  columns?: number;
  rows?: number;

  constructor(fd: number, private readonly sink: (chunk: string | Uint8Array) => void, terminal: ProgramIO['terminal']) {
    super({ decodeStrings: false });
    this.fd = fd;
    this.isTTY = !!terminal;
    if (terminal) {
      this.columns = terminal.cols;
      this.rows = terminal.rows;
      terminal.onResize((cols, rows) => {
        this.columns = cols;
        this.rows = rows;
        this.emit('resize');
      });
    }
  }

  override _write(chunk: string | Uint8Array, _encoding: string, callback: () => void): void {
    this.sink(chunk);
    callback();
  }

  /** Synchronous, like Node's stdout to a TTY or file: output order matches call order. */
  override write(chunk: unknown, encoding?: any, callback?: any): boolean {
    if (typeof encoding === 'function') callback = encoding;
    this.sink(typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk));
    if (typeof callback === 'function') queueMicrotask(callback);
    return true;
  }

  getColorDepth(): number {
    return this.isTTY ? 8 : 1;
  }
  hasColors(count = 16): boolean {
    return this.isTTY && count <= 256;
  }
  getWindowSize(): [number, number] {
    return [this.columns ?? 80, this.rows ?? 24];
  }
  cursorTo(x: number, y?: number | (() => void), cb?: () => void): boolean {
    this.write(typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`);
    (typeof y === 'function' ? y : cb)?.();
    return true;
  }
  moveCursor(dx: number, dy: number, cb?: () => void): boolean {
    this.write((dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : '') + (dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : ''));
    cb?.();
    return true;
  }
  clearLine(dir = 0, cb?: () => void): boolean {
    this.write(dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
    cb?.();
    return true;
  }
  clearScreenDown(cb?: () => void): boolean {
    this.write('\x1b[0J');
    cb?.();
    return true;
  }
}

class StdinStream extends Readable {
  isTTY: boolean;
  isRaw = false;
  fd = 0;
  private subscription?: () => void;
  private release?: () => void;

  constructor(private readonly io: ProgramIO, private readonly loop: EventLoop) {
    super({ encoding: 'utf8' });
    this.isTTY = !!io.terminal;
  }

  override _read(): void {
    this.listen();
  }

  override resume(): this {
    this.listen();
    return super.resume();
  }

  override pause(): this {
    this.stopListening();
    return super.pause();
  }

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    this.io.terminal?.setRawMode(raw);
    return this;
  }

  ref(): this {
    if (this.subscription && !this.release) this.release = this.loop.hold();
    return this;
  }

  unref(): this {
    this.release?.();
    this.release = undefined;
    return this;
  }

  private listen(): void {
    if (this.subscription) return;
    this.release = this.loop.hold();
    this.subscription = this.io.onStdin((chunk) => {
      if (chunk === null) {
        this.stopListening();
        this.push(null);
      } else this.push(chunk);
    });
  }

  private stopListening(): void {
    this.subscription?.();
    this.subscription = undefined;
    this.release?.();
    this.release = undefined;
  }
}

export type NodeProcess = EventEmitterBase & Record<string, any>;

export function createProcess(options: ProcessOptions): NodeProcess {
  const { io, loop, fs } = options;
  let cwd = normalizePath(options.cwd);
  let exited = false;
  const started = performance.now();
  const proc = new EventEmitterBase() as NodeProcess;
  const pid = nextPid++;

  const exit = (code?: number) => {
    if (code !== undefined) proc.exitCode = code;
    if (!exited) {
      exited = true;
      const final = Number(proc.exitCode ?? 0) || 0;
      try {
        proc.emit('exit', final);
      } catch {
        // an 'exit' listener that throws must not stop the exit
      }
      options.onExit(Number(proc.exitCode ?? final) || 0);
    }
    throw new ProcessExit(Number(proc.exitCode ?? 0) || 0);
  };

  const hrtime = (previous?: [number, number]): [number, number] => {
    const now = performance.now();
    let seconds = Math.floor(now / 1000);
    let nanos = Math.floor((now % 1000) * 1e6);
    if (previous) {
      seconds -= previous[0];
      nanos -= previous[1];
      if (nanos < 0) {
        seconds--;
        nanos += 1e9;
      }
    }
    return [seconds, nanos];
  };
  hrtime.bigint = () => BigInt(Math.floor(performance.now() * 1e6));

  const memoryUsage = () => ({ rss: 50e6, heapTotal: 30e6, heapUsed: 20e6, external: 1e6, arrayBuffers: 1e5 });
  memoryUsage.rss = () => 50e6;

  Object.assign(proc, {
    title: 'node',
    version: `v${NODE_VERSION}`,
    versions: { node: NODE_VERSION, v8: '11.3.244.8-node.23', uv: '1.48.0', zlib: '1.3.0.1', modules: '115', napi: '9', unicode: '15.1' },
    release: { name: 'node', lts: 'Iron' },
    platform: 'linux',
    arch: 'x64',
    pid,
    ppid: pid - 1,
    argv: options.argv,
    argv0: 'node',
    execPath: '/usr/local/bin/node',
    execArgv: [],
    env: options.env,
    exitCode: undefined as number | undefined,
    config: { variables: {} },
    features: { inspector: false, ipv6: true, tls: true, typescript: false },
    allowedNodeEnvironmentFlags: new Set<string>(),
    stdout: new TtyWriteStream(1, io.stdout, io.terminal),
    stderr: new TtyWriteStream(2, io.stderr, io.terminal),
    stdin: new StdinStream(io, loop),
    cwd: () => cwd,
    chdir(dir: string) {
      const target = dir.startsWith('/') ? normalizePath(dir) : join(cwd, dir);
      if (!fs.isDirectory(target)) throw fsError(fs.isFile(target) ? 'ENOTDIR' : 'ENOENT', 'chdir', target);
      cwd = target;
    },
    exit,
    reallyExit: exit,
    abort: () => exit(134),
    kill(target: number, signal: string | number = 'SIGTERM') {
      if (target !== pid) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      if (proc.listenerCount(String(signal))) proc.emit(String(signal), String(signal));
      else exit(143);
      return true;
    },
    nextTick(fn: (...args: unknown[]) => void, ...args: unknown[]) {
      queueMicrotask(() => loop._run(() => fn(...args)));
    },
    hrtime,
    memoryUsage,
    cpuUsage: () => ({ user: Math.floor((performance.now() - started) * 1000), system: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 50000 }),
    uptime: () => (performance.now() - started) / 1000,
    umask: () => 0o22,
    getuid: () => 1000,
    geteuid: () => 1000,
    getgid: () => 1000,
    getegid: () => 1000,
    getgroups: () => [1000],
    emitWarning(warning: string | Error, type?: string | { type?: string }) {
      const name = typeof type === 'string' ? type : type?.type ?? (warning instanceof Error ? warning.name : 'Warning');
      const message = warning instanceof Error ? warning.message : warning;
      proc.emit('warning', Object.assign(new Error(message), { name }));
      io.stderr(`(node:${pid}) ${name}: ${message}\n`);
    },
    binding(name: string) {
      throw new Error(`No such module: ${name}`);
    },
    getActiveResourcesInfo: () => [],
    setUncaughtExceptionCaptureCallback: () => undefined,
    hasUncaughtExceptionCaptureCallback: () => false,
    setSourceMapsEnabled: () => undefined,
    report: { getReport: () => ({ header: { glibcVersionRuntime: '2.36' } }) },
    connected: false,
  });
  return proc;
}

/** console bound to a process's stdio (`console.log` in user code prints to the terminal). */
export function createConsole(proc: NodeProcess): Console {
  const out = (stream: 'stdout' | 'stderr') => (...args: unknown[]) => proc[stream].write(format(...args) + '\n');
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();
  let indent = '';
  const withIndent = (fn: (...args: unknown[]) => void) => (...args: unknown[]) => (indent ? fn(indent + format(...args).replace(/\n/g, '\n' + indent)) : fn(...args));
  const log = withIndent(out('stdout'));
  const error = withIndent(out('stderr'));
  return {
    log,
    info: log,
    debug: log,
    warn: error,
    error,
    trace: (...args: unknown[]) => error(`Trace: ${format(...args)}\n${new Error().stack?.split('\n').slice(2).join('\n') ?? ''}`),
    dir: (value: unknown) => log(value),
    dirxml: log,
    table: (value: unknown) => log(value),
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) error('Assertion failed' + (args.length ? `: ${format(...args)}` : ''));
    },
    count: (label = 'default') => {
      counts.set(label, (counts.get(label) ?? 0) + 1);
      log(`${label}: ${counts.get(label)}`);
    },
    countReset: (label = 'default') => void counts.delete(label),
    group: (...args: unknown[]) => {
      if (args.length) log(...args);
      indent += '  ';
    },
    groupCollapsed: (...args: unknown[]) => {
      if (args.length) log(...args);
      indent += '  ';
    },
    groupEnd: () => void (indent = indent.slice(2)),
    time: (label = 'default') => void timers.set(label, performance.now()),
    timeLog: (label = 'default', ...args: unknown[]) => log(`${label}: ${(performance.now() - (timers.get(label) ?? 0)).toFixed(3)}ms`, ...args),
    timeEnd: (label = 'default') => {
      log(`${label}: ${(performance.now() - (timers.get(label) ?? 0)).toFixed(3)}ms`);
      timers.delete(label);
    },
    clear: () => undefined,
    profile: () => undefined,
    profileEnd: () => undefined,
    timeStamp: () => undefined,
  } as unknown as Console;
}
