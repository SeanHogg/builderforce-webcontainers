/**
 * The page side of the Node runtime: one Web Worker per process. The page owns
 * the master file system and the port table; each worker gets a snapshot of
 * the files at start, and writes flow both ways as batched ops (a worker's
 * write reaches the page, then every other worker). Children a worker spawns
 * (the shell running `node`, `child_process`) are started here too, so every
 * process — however deep — can be killed by terminating its worker.
 */
import {
  DEFAULT_ENV,
  PortRegistry,
  allocatePid,
  toWebContainerProcess,
  type ChildHandle,
  type FsChange,
  type HttpRequestData,
  type HttpResponseData,
  type SpawnOptions,
  type VirtualFileSystem,
  type WebContainerProcess,
} from '@seanhogg/builderforce-webcontainers-core';
import type { FsOp, HostToWorker, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';

/** The part of `Worker` the host uses — a real Worker, or an in-thread fake in tests. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export interface ProcessHostOptions {
  fs: VirtualFileSystem;
  createWorker(): WorkerLike;
  /** Origin and base path previews are served under (`/__bfwc/<id>/`). */
  previewOrigin: string;
  previewBase: string;
  /** The dev server's preview URL, for the `vite`/`react-scripts start` handoff. */
  previewUrl?: string;
  registry?: string;
  /** Cache npm tarballs in Cache Storage. Default true. */
  packageCache?: boolean;
  env?: Record<string, string>;
  /** How long a killed process may take to exit before its worker is terminated. Default 2000ms. */
  killGraceMs?: number;
}

const SIGNAL_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGKILL: 137, SIGHUP: 129 };

interface Proc {
  pid: number;
  worker: WorkerLike;
  stdout: Set<(chunk: string) => void>;
  stderr: Set<(chunk: string) => void>;
  exited: boolean;
  resolveExit(code: number): void;
  registrations: Map<number, { close(): void }>;
  children: Map<number, ChildHandle>;
  pendingHttp: Map<number, (response: HttpResponseData) => void>;
  outbox: FsOp[];
}

export class ProcessHost {
  readonly ports = new PortRegistry();
  private readonly procs = new Set<Proc>();
  private readonly serverReady = new Set<(port: number, url: string) => void>();
  private readonly portListeners = new Set<(port: number, type: 'open' | 'close', url: string) => void>();
  private applyingFrom?: Proc;
  private flushScheduled = false;
  private nextReq = 1;
  private readonly unwatch: () => void;
  private readonly stopPorts: () => void;

  constructor(private readonly options: ProcessHostOptions) {
    this.unwatch = options.fs.watch((change) => this.onFsChange(change));
    this.stopPorts = this.ports.watch(({ type, port }) => {
      const url = this.serverUrl(port);
      for (const proc of this.procs) this.post(proc, { type: 'ports', open: type === 'open' ? [port] : [], closed: type === 'close' ? [port] : [] });
      for (const l of this.portListeners) l(port, type, url);
      if (type === 'open') for (const l of this.serverReady) l(port, url);
    });
  }

  serverUrl(port: number): string {
    return new URL(portPath(this.options.previewBase, port), this.options.previewOrigin).href;
  }

  /** Same shape as `WebContainer#spawn`. */
  spawn(command: string, args: string[] | SpawnOptions = [], options: SpawnOptions = {}): WebContainerProcess {
    if (!Array.isArray(args)) [options, args] = [args, []];
    return toWebContainerProcess(this.spawnChild(command, args, options), !!options.terminal);
  }

  spawnChild(command: string, args: string[] = [], options: SpawnOptions = {}): ChildHandle {
    const pid = allocatePid();
    const worker = this.options.createWorker();
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    const proc: Proc = {
      pid,
      worker,
      stdout: new Set(),
      stderr: new Set(),
      exited: false,
      resolveExit: (code) => {
        if (proc.exited) return;
        proc.exited = true;
        this.cleanup(proc);
        resolveExit(code);
      },
      registrations: new Map(),
      children: new Map(),
      pendingHttp: new Map(),
      outbox: [],
    };
    this.procs.add(proc);
    worker.onmessage = (event) => this.onWorkerMessage(proc, event.data as WorkerToHost);
    worker.onerror = (event) => {
      for (const l of proc.stderr) l(`Process worker failed: ${event?.message ?? 'unknown error'}\n`);
      proc.resolveExit(1);
    };
    const { fs } = this.options;
    this.post(proc, {
      type: 'start',
      pid,
      command,
      args,
      cwd: options.cwd ?? '/',
      env: { ...DEFAULT_ENV, ...this.options.env, ...options.env },
      terminal: options.terminal,
      files: fs.list().map((path) => [path, fs.readFile(path)!]),
      dirs: fs.explicitDirectories(),
      ports: this.ports.ports(),
      previewOrigin: this.options.previewOrigin,
      previewBase: this.options.previewBase,
      previewUrl: this.options.previewUrl,
      registry: this.options.registry,
      packageCache: this.options.packageCache !== false,
    });

    return {
      pid,
      onStdout: (l) => (proc.stdout.add(l), () => proc.stdout.delete(l)),
      onStderr: (l) => (proc.stderr.add(l), () => proc.stderr.delete(l)),
      write: (data) => this.post(proc, { type: 'stdin', data }),
      closeStdin: () => this.post(proc, { type: 'stdin', data: null }),
      kill: (signal = 'SIGTERM') => this.kill(proc, signal),
      resize: (cols, rows) => this.post(proc, { type: 'resize', cols, rows }),
      exit,
    };
  }

  /** Dispatch an HTTP request to the server on `port` (the preview service worker's `/__port/<port>/` path). */
  request(port: number, request: HttpRequestData): Promise<HttpResponseData | undefined> {
    return this.ports.request(port, request);
  }

  on(event: 'server-ready', listener: (port: number, url: string) => void): () => void;
  on(event: 'port', listener: (port: number, type: 'open' | 'close', url: string) => void): () => void;
  on(event: 'server-ready' | 'port', listener: (...args: any[]) => void): () => void {
    const set = (event === 'server-ready' ? this.serverReady : this.portListeners) as Set<(...args: any[]) => void>;
    set.add(listener);
    return () => set.delete(listener);
  }

  dispose(): void {
    for (const proc of [...this.procs]) {
      proc.worker.terminate();
      proc.resolveExit(SIGNAL_CODES.SIGKILL!);
    }
    this.unwatch();
    this.stopPorts();
  }

  private kill(proc: Proc, signal: string): void {
    if (proc.exited) return;
    if (signal === 'SIGKILL') {
      proc.worker.terminate();
      proc.resolveExit(SIGNAL_CODES.SIGKILL!);
      return;
    }
    this.post(proc, { type: 'kill', signal });
    // A process stuck in a loop never sees the signal: terminate its worker.
    setTimeout(() => {
      if (proc.exited) return;
      proc.worker.terminate();
      proc.resolveExit(SIGNAL_CODES[signal] ?? 1);
    }, this.options.killGraceMs ?? 2000);
  }

  private cleanup(proc: Proc): void {
    for (const registration of proc.registrations.values()) registration.close();
    proc.registrations.clear();
    for (const respond of proc.pendingHttp.values()) respond({ status: 502, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('The server process exited.') });
    proc.pendingHttp.clear();
    this.procs.delete(proc);
    queueMicrotask(() => proc.worker.terminate());
  }

  private post(proc: Proc, message: HostToWorker): void {
    if (!proc.exited || message.type === 'start') proc.worker.postMessage(message);
  }

  private onFsChange(change: FsChange): void {
    const op: FsOp = change.type === 'write' ? { op: 'write', path: change.path, content: this.options.fs.readFile(change.path)! } : { op: change.type, path: change.path };
    for (const proc of this.procs) if (proc !== this.applyingFrom) proc.outbox.push(op);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flushOutboxes());
  }

  private flushOutboxes(): void {
    this.flushScheduled = false;
    for (const proc of this.procs) {
      if (!proc.outbox.length) continue;
      const ops = proc.outbox;
      proc.outbox = [];
      this.post(proc, { type: 'fs', ops });
    }
  }

  private onWorkerMessage(proc: Proc, message: WorkerToHost): void {
    switch (message.type) {
      case 'stdout':
        for (const l of proc.stdout) l(message.data);
        return;
      case 'stderr':
        for (const l of proc.stderr) l(message.data);
        return;
      case 'exit':
        this.flushOutboxes();
        return proc.resolveExit(message.code);
      case 'fs': {
        this.applyingFrom = proc;
        try {
          for (const op of message.ops) {
            if (op.op === 'write') this.options.fs.writeFile(op.path, op.content);
            else if (op.op === 'mkdir') this.options.fs.mkdir(op.path);
            else this.options.fs.rm(op.path);
          }
        } finally {
          this.applyingFrom = undefined;
        }
        return;
      }
      case 'spawn': {
        this.flushOutboxes();
        let child: ChildHandle;
        try {
          child = this.spawnChild(message.command, message.args, { cwd: message.cwd, env: message.env, terminal: message.terminal });
        } catch (error) {
          return this.post(proc, { type: 'child-error', childId: message.childId, code: (error as { code?: string }).code ?? 'EFAIL', message: (error as Error).message });
        }
        proc.children.set(message.childId, child);
        child.onStdout((data) => this.post(proc, { type: 'child-out', childId: message.childId, stream: 'stdout', data }));
        child.onStderr((data) => this.post(proc, { type: 'child-out', childId: message.childId, stream: 'stderr', data }));
        void child.exit.then((code) => {
          proc.children.delete(message.childId);
          this.post(proc, { type: 'child-exit', childId: message.childId, code });
        });
        return;
      }
      case 'child-stdin': {
        const child = proc.children.get(message.childId);
        if (message.data === null) child?.closeStdin();
        else child?.write(message.data);
        return;
      }
      case 'child-kill':
        return proc.children.get(message.childId)?.kill(message.signal);
      case 'child-resize':
        return proc.children.get(message.childId)?.resize?.(message.cols, message.rows);
      case 'listen': {
        try {
          const registration = this.ports.listen(message.port, (request) => this.forward(proc, message.port, request));
          proc.registrations.set(message.port, registration);
        } catch (error) {
          for (const l of proc.stderr) l(`${(error as Error).message}\n`);
        }
        return;
      }
      case 'unlisten':
        proc.registrations.get(message.port)?.close();
        proc.registrations.delete(message.port);
        return;
      case 'http-response':
        proc.pendingHttp.get(message.reqId)?.(message.response);
        proc.pendingHttp.delete(message.reqId);
        return;
      case 'loopback':
        void this.ports.request(message.port, message.request).then((response) => this.post(proc, { type: 'loopback-response', reqId: message.reqId, response: response ?? null }));
        return;
      case 'server-ready':
        for (const l of this.serverReady) l(message.port, message.url);
        return;
    }
  }

  private forward(proc: Proc, port: number, request: HttpRequestData): Promise<HttpResponseData> {
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      proc.pendingHttp.set(reqId, resolve);
      this.post(proc, { type: 'http-request', reqId, port, request });
    });
  }
}
