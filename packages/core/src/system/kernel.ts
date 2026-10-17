/**
 * The in-process kernel: every program runs on the calling thread, sharing one
 * VFS and one port registry. It is what the tests drive, and a host that does
 * not need preemption (a CLI, a server-side sandbox) can use it as is. The
 * browser runtime runs the same programs one-per-Worker instead, so a busy
 * loop cannot freeze the page (see the browser package's node host).
 */
import { VirtualFileSystem } from '../vfs.js';
import type { PackageCache } from '../installer/registry.js';
import type { ByteChannel, ChildHandle, HttpRequestData, HttpResponseData, HttpStreamResponse, Program, ProcessOptions, System } from './types.js';
import { PortRegistry } from './ports.js';
import { ServerEvents } from './serverEvents.js';
import { commandNotFound, resolveCommand } from './commands.js';
import { runArguments, runProgram, toRuntimeProcess, type RuntimeProcess } from './process.js';

export interface KernelOptions {
  fs?: VirtualFileSystem;
  /** Programs by command name. The full set comes from `defaultPrograms()`. */
  programs: Record<string, Program>;
  fetch?: System['fetch'];
  /** Base environment for every process. */
  env?: Record<string, string>;
  /** Where a browser reaches a server on `port`. Default `http://localhost:<port>/`. */
  serverUrl?(port: number): string;
  previewUrl?: string;
  registry?: string;
  packageCache?: PackageCache;
}

export const DEFAULT_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/user',
  USER: 'user',
  SHELL: '/bin/bfsh',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  NODE_ENV: 'development',
};

export class Kernel {
  readonly fs: VirtualFileSystem;
  readonly ports = new PortRegistry();
  /** Servers listening, ports opening and closing. */
  readonly servers = new ServerEvents();
  readonly env: Record<string, string>;
  private readonly system: System;

  constructor(private readonly options: KernelOptions) {
    this.fs = options.fs ?? new VirtualFileSystem();
    this.env = { ...DEFAULT_ENV, ...options.env };
    const serverUrl = (port: number) => options.serverUrl?.(port) ?? `http://localhost:${port}/`;
    this.ports.watch(({ type, port }) => this.servers.portChanged({ type, port, url: serverUrl(port) }));
    this.system = {
      fs: this.fs,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      spawn: (command, args, spawnOptions) => this.spawnChild(command, args, spawnOptions),
      listen: (port, handler, upgrade) => this.ports.listen(port, handler, upgrade),
      loopback: (port, request) => this.ports.request(port, request),
      serverUrl,
      announceServer: (port, url) => this.servers.announce({ port, url }),
      previewUrl: options.previewUrl,
      registry: options.registry,
      packageCache: options.packageCache,
    };
  }

  /** Start a command — `run('npm', ['install'])`, `run('bfsh', { terminal })` — as a stream-based {@link RuntimeProcess}. */
  run(command: string, args?: string[], options?: ProcessOptions): RuntimeProcess;
  run(command: string, options?: ProcessOptions): RuntimeProcess;
  run(command: string, argsOrOptions?: string[] | ProcessOptions, maybeOptions?: ProcessOptions): RuntimeProcess {
    const [args, options] = runArguments(argsOrOptions, maybeOptions);
    return toRuntimeProcess(this.spawnChild(command, args, options), !!options.terminal);
  }

  /** A child as a program's parent sees it — what `System.spawn` returns. */
  spawnChild(command: string, args: string[] = [], options: ProcessOptions = {}): ChildHandle {
    const cwd = options.cwd ?? '/';
    const env = { ...this.env, ...options.env };
    const resolved = resolveCommand(this.fs, this.options.programs, command, args, cwd, env);
    if (!resolved) throw commandNotFound(command);
    return runProgram({ program: resolved.program, args: resolved.args, system: this.system, cwd, env, terminal: options.terminal });
  }

  /** Send an HTTP request to a virtual server (what the preview service worker does in the browser); resolves with the whole response. */
  request(port: number, request: Partial<HttpRequestData> & { url: string }): Promise<HttpResponseData | undefined> {
    return this.ports.requestBuffered(port, withDefaults(request));
  }

  /** {@link request}, resolving at the head with the body streaming (Server-Sent Events, chunked progress). */
  requestStream(port: number, request: Partial<HttpRequestData> & { url: string }): Promise<HttpStreamResponse | undefined> {
    return this.ports.request(port, withDefaults(request));
  }

  /** Open an upgraded connection (a WebSocket, via `connectWebSocket`); undefined when nothing on `port` takes upgrades. */
  upgrade(port: number, request: Partial<HttpRequestData> & { url: string }): ByteChannel | undefined {
    return this.ports.upgrade(port, withDefaults(request));
  }
}

const withDefaults = (request: Partial<HttpRequestData> & { url: string }): HttpRequestData => ({ method: 'GET', headers: {}, body: null, ...request });
