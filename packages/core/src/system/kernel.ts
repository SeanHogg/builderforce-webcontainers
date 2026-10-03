/**
 * The in-process kernel: every program runs on the calling thread, sharing one
 * VFS and one port registry. It is what the tests drive, and a host that does
 * not need preemption (a CLI, a server-side sandbox) can use it as is. The
 * browser runtime runs the same programs one-per-Worker instead, so a busy
 * loop cannot freeze the page (see the browser package's node host).
 */
import { VirtualFileSystem } from '../vfs.js';
import type { PackageCache } from '../installer/registry.js';
import type { ChildHandle, HttpRequestData, HttpResponseData, Program, SpawnOptions, System } from './types.js';
import { PortRegistry } from './ports.js';
import { commandNotFound, resolveCommand } from './commands.js';
import { runProgram, toWebContainerProcess, type WebContainerProcess } from './process.js';

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

export interface KernelSpawnOptions extends SpawnOptions {
  /** Kept for `@webcontainer/api` parity; output is always delivered. */
  output?: boolean;
}

type ServerReadyListener = (port: number, url: string) => void;
type PortListener = (port: number, type: 'open' | 'close', url: string) => void;

export const DEFAULT_ENV: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/user',
  USER: 'user',
  SHELL: '/bin/jsh',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  LANG: 'en_US.UTF-8',
  NODE_ENV: 'development',
};

export class Kernel {
  readonly fs: VirtualFileSystem;
  readonly ports = new PortRegistry();
  readonly env: Record<string, string>;
  private readonly serverReady = new Set<ServerReadyListener>();
  private readonly portListeners = new Set<PortListener>();
  private readonly system: System;

  constructor(private readonly options: KernelOptions) {
    this.fs = options.fs ?? new VirtualFileSystem();
    this.env = { ...DEFAULT_ENV, ...options.env };
    const serverUrl = (port: number) => options.serverUrl?.(port) ?? `http://localhost:${port}/`;
    this.ports.watch(({ type, port }) => {
      const url = serverUrl(port);
      for (const l of this.portListeners) l(port, type, url);
      if (type === 'open') for (const l of this.serverReady) l(port, url);
    });
    this.system = {
      fs: this.fs,
      fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      spawn: (command, args, spawnOptions) => this.spawnChild(command, args, spawnOptions),
      listen: (port, handler) => this.ports.listen(port, handler),
      loopback: (port, request) => this.ports.request(port, request),
      serverUrl,
      announceServer: (port, url) => this.serverReady.forEach((l) => l(port, url)),
      previewUrl: options.previewUrl,
      registry: options.registry,
      packageCache: options.packageCache,
    };
  }

  /** Same shape as `WebContainer#spawn`. */
  spawn(command: string, args: string[] | KernelSpawnOptions = [], options: KernelSpawnOptions = {}): WebContainerProcess {
    if (!Array.isArray(args)) [options, args] = [args, []];
    return toWebContainerProcess(this.spawnChild(command, args, options), !!options.terminal);
  }

  /** A child as a program's parent sees it — what `System.spawn` returns. */
  spawnChild(command: string, args: string[] = [], options: SpawnOptions = {}): ChildHandle {
    const cwd = options.cwd ?? '/';
    const env = { ...this.env, ...options.env };
    const resolved = resolveCommand(this.fs, this.options.programs, command, args, cwd, env);
    if (!resolved) throw commandNotFound(command);
    return runProgram({ program: resolved.program, args: resolved.args, system: this.system, cwd, env, terminal: options.terminal });
  }

  /** Send an HTTP request to a virtual server (what the preview service worker does in the browser). */
  request(port: number, request: Partial<HttpRequestData> & { url: string }): Promise<HttpResponseData | undefined> {
    return this.ports.request(port, { method: 'GET', headers: {}, body: null, ...request });
  }

  on(event: 'server-ready', listener: ServerReadyListener): () => void;
  on(event: 'port', listener: PortListener): () => void;
  on(event: 'server-ready' | 'port', listener: ServerReadyListener | PortListener): () => void {
    const set = (event === 'server-ready' ? this.serverReady : this.portListeners) as Set<typeof listener>;
    set.add(listener);
    return () => set.delete(listener);
  }
}
