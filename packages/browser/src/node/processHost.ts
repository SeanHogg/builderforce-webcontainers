/**
 * The page side of the Node runtime: one Web Worker per process. The page owns
 * the master file system and the port table; each worker gets a snapshot of
 * the files at start — a pack cached across spawns plus the journal ops since
 * it (core vfs/snapshots.ts) — and writes flow both ways as batched ops (a worker's
 * write reaches the page, then every other worker; fsSync.ts). Children a worker spawns
 * (the shell running `node`, `child_process`) are started here too, so every
 * process — however deep — can be killed by terminating its worker. Ending a
 * process (exit, kill, dispose) ends its children too, unless spawned `detached`.
 *
 * Responses from a worker's servers stream through here chunk by chunk (see
 * responseWire.ts); connections — upgraded (WebSockets) and raw TCP, to a
 * worker's servers or dialled by it — are relayed as raw bytes (connectionRelay.ts).
 */
import {
  DEFAULT_ENV,
  PortRegistry,
  ServerEvents,
  allocatePid,
  createIpcEndpoint,
  runArguments,
  signalExitCode,
  textResponse,
  toRuntimeProcess,
  type ByteChannel,
  type ChildHandle,
  type HttpRequestData,
  type HttpResponseData,
  type HttpStreamResponse,
  type ProcessOptions,
  type RuntimeProcess,
  type StdioChunk,
  type VfsSnapshots,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';
import { ResponseReceiver, sendResponse } from './responseWire.js';
import { ChildRelay, isChildMessage } from './childRelay.js';
import { ConnectionRelay, isConnectionMessage } from './connectionRelay.js';
import { WorkerSupply } from './workerSupply.js';
import { FsSync } from './fsSync.js';

/** The part of `Worker` the host uses — a real Worker, or an in-thread fake in tests. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export interface ProcessHostOptions {
  fs: VirtualFileSystem;
  /** Where a process starts when `run` names no `cwd`. Default `/`. */
  cwd?: string;
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
  /** After a spawn, keep one spare Worker primed with the file system, so the next spawn sends only the changes since. Default true. */
  warmWorker?: boolean;
}

/** A running process, as `listProcesses()` reports it. */
export interface ProcessInfo {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  /** Epoch ms. */
  startedAt: number;
  /** Ports its servers listen on. */
  ports: number[];
}

interface Proc {
  pid: number;
  info: Omit<ProcessInfo, 'ports'>;
  worker: WorkerLike;
  stdout: Set<(chunk: StdioChunk) => void>;
  stderr: Set<(chunk: StdioChunk) => void>;
  exited: boolean;
  resolveExit(code: number): void;
  registrations: Map<number, { close(): void }>;
  /** The children its Worker spawned, relayed back to it. */
  children: ChildRelay;
  /** Its message channel to whoever spawned it with `ipc`: the parent's side. */
  ipc?: ReturnType<typeof createIpcEndpoint>;
  /** Responses its servers are streaming back to requests forwarded here. */
  responses: ResponseReceiver;
  /** Its loopback requests being answered, by the worker's request id: cancel functions. */
  loopbacks: Map<number, () => void>;
  /** Connections to its servers (upgraded or raw TCP) and the ones it dialled. */
  connections: ConnectionRelay;
}

const EXITED = 'The server process exited.';

export class ProcessHost {
  readonly ports = new PortRegistry();
  /** Servers listening, ports opening and closing. */
  readonly servers = new ServerEvents();
  private readonly procs = new Set<Proc>();
  private nextReq = 1;
  private readonly stopPorts: () => void;
  /** The processes' file systems kept in step with the page's, and the snapshots new ones start from. */
  private readonly fsSync: FsSync<Proc>;
  /** New processes' Workers: a primed spare when there is one, else a new Worker and the snapshot. */
  readonly workers: WorkerSupply;

  constructor(private readonly options: ProcessHostOptions) {
    this.fsSync = new FsSync(options.fs, (proc, ops) => this.post(proc, { type: 'fs', ops }));
    this.workers = new WorkerSupply(() => options.createWorker(), this.fsSync.snapshots, options.warmWorker !== false);
    this.stopPorts = this.ports.watch(({ type, port }) => {
      const url = this.serverUrl(port);
      for (const proc of this.procs) this.post(proc, { type: 'ports', open: type === 'open' ? [port] : [], closed: type === 'close' ? [port] : [] });
      this.servers.portChanged({ type, port, url });
    });
  }

  /** What each new process starts from: one pack reused until the project outgrows it, plus the ops since. */
  get snapshots(): VfsSnapshots {
    return this.fsSync.snapshots;
  }

  serverUrl(port: number): string {
    return new URL(portPath(this.options.previewBase, port), this.options.previewOrigin).href;
  }

  /** Start a command in its own Web Worker, as a stream-based {@link RuntimeProcess}. */
  run(command: string, args?: string[], options?: ProcessOptions): RuntimeProcess;
  run(command: string, options?: ProcessOptions): RuntimeProcess;
  run(command: string, argsOrOptions?: string[] | ProcessOptions, maybeOptions?: ProcessOptions): RuntimeProcess {
    const [args, options] = runArguments(argsOrOptions, maybeOptions);
    return toRuntimeProcess(this.spawnChild(command, args, options), !!options.terminal);
  }

  spawnChild(command: string, args: string[] = [], options: ProcessOptions = {}): ChildHandle {
    const pid = allocatePid();
    const cwd = options.cwd ?? this.options.cwd ?? '/';
    const { worker, snapshot } = this.workers.take();
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    const proc: Proc = {
      pid,
      info: { pid, command, args: [...args], cwd, startedAt: Date.now() },
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
      children: new ChildRelay((childCommand, childArgs, childOptions) => {
        this.fsSync.flush(); // the child must see every write made so far
        return this.spawnChild(childCommand, childArgs, childOptions);
      }, (message) => this.post(proc, message)),
      responses: new ResponseReceiver(),
      loopbacks: new Map(),
      connections: new ConnectionRelay(this.ports, (message) => this.post(proc, message)),
    };
    if (options.ipc) proc.ipc = createIpcEndpoint((data) => this.post(proc, { type: 'ipc', data }), () => this.post(proc, { type: 'ipc-disconnect' }));
    this.procs.add(proc);
    this.fsSync.add(proc);
    worker.onmessage = (event) => this.onWorkerMessage(proc, event.data as WorkerToHost);
    worker.onerror = (event) => {
      for (const l of proc.stderr) l(`Process worker failed: ${event?.message ?? 'unknown error'}\n`);
      proc.resolveExit(1);
    };
    this.post(proc, {
      type: 'start',
      pid,
      command,
      args,
      cwd,
      env: { ...DEFAULT_ENV, ...this.options.env, ...options.env },
      terminal: options.terminal,
      ipc: options.ipc,
      thread: options.thread,
      snapshot,
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
      ipc: proc.ipc?.endpoint,
    };
  }

  /** Every process still running, oldest first — children started by a shell included. */
  list(): ProcessInfo[] {
    return [...this.procs].map((proc) => ({ ...proc.info, args: [...proc.info.args], ports: [...proc.registrations.keys()] }));
  }

  /** Dispatch an HTTP request to the server on `port` and wait for the whole response. */
  request(port: number, request: HttpRequestData): Promise<HttpResponseData | undefined> {
    return this.ports.requestBuffered(port, request);
  }

  /** Dispatch an HTTP request to the server on `port` (the preview's `/__port/<port>/` path); resolves at the head, the body streaming. */
  requestStream(port: number, request: HttpRequestData): Promise<HttpStreamResponse | undefined> {
    return this.ports.request(port, request);
  }

  /** Open an upgraded connection (a WebSocket) to the server on `port`; returns the client end. */
  upgrade(port: number, request: HttpRequestData): ByteChannel | undefined {
    return this.ports.upgrade(port, request);
  }

  dispose(): void {
    for (const proc of [...this.procs]) this.terminate(proc, signalExitCode('SIGKILL'));
    this.stopPorts();
    this.workers.dispose();
    this.fsSync.dispose();
  }

  private kill(proc: Proc, signal: string): void {
    if (proc.exited) return;
    if (signal === 'SIGKILL') return this.terminate(proc, signalExitCode('SIGKILL'));
    this.post(proc, { type: 'kill', signal });
    // A process stuck in a loop never sees the signal: terminate its worker.
    setTimeout(() => {
      if (!proc.exited) this.terminate(proc, signalExitCode(signal));
    }, this.options.killGraceMs ?? 2000);
  }

  /** Stop a process now: its children first (sibling Workers that would outlive it), then its own Worker. */
  private terminate(proc: Proc, code: number): void {
    if (proc.exited) return;
    proc.children.killAll('SIGKILL');
    proc.worker.terminate();
    proc.resolveExit(code);
  }

  private cleanup(proc: Proc): void {
    for (const registration of proc.registrations.values()) registration.close();
    proc.registrations.clear();
    proc.responses.abort(() => textResponse(502, EXITED), EXITED);
    for (const cancel of [...proc.loopbacks.values()]) cancel();
    proc.loopbacks.clear();
    proc.connections.closeAll();
    proc.ipc?.closed();
    // Exited on its own: its children get SIGTERM (and the grace period), as a real parent's would.
    proc.children.killAll('SIGTERM');
    this.procs.delete(proc);
    this.fsSync.remove(proc);
    queueMicrotask(() => proc.worker.terminate());
  }

  private post(proc: Proc, message: HostToWorker): void {
    if (!proc.exited || message.type === 'start') proc.worker.postMessage(message);
  }

  private onWorkerMessage(proc: Proc, message: WorkerToHost): void {
    if (isChildMessage(message)) return proc.children.receive(message);
    if (isConnectionMessage(message)) return proc.connections.receive(message);
    switch (message.type) {
      case 'stdout':
        for (const l of proc.stdout) l(message.data);
        return;
      case 'stderr':
        for (const l of proc.stderr) l(message.data);
        return;
      case 'exit':
        this.fsSync.flush();
        return proc.resolveExit(message.code);
      case 'fs':
        return this.fsSync.applyFrom(proc, message.ops);
      case 'primed':
        return; // a spare's acknowledgement; WorkerSupply reads it before the spare becomes a process
      case 'ipc':
        return proc.ipc?.receive(message.data);
      case 'ipc-disconnect':
        return proc.ipc?.closed();
      case 'listen': {
        try {
          const { port } = message;
          const registration = this.ports.listen(
            port,
            (request) => this.forward(proc, port, request),
            (request, socket) => (proc.exited ? socket.close() : proc.connections.upgrade(port, request, socket)),
            message.tcp ? (socket) => (proc.exited ? socket.close() : proc.connections.accept(port, socket)) : undefined,
          );
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
      case 'response-head':
      case 'response-chunk':
      case 'response-end':
        return proc.responses.receive(message);
      case 'loopback': {
        const { reqId } = message;
        const cancel = sendResponse((reply) => this.post(proc, reply), reqId, this.ports.request(message.port, message.request), () => proc.loopbacks.delete(reqId));
        proc.loopbacks.set(reqId, cancel);
        return;
      }
      case 'request-cancel':
        return proc.loopbacks.get(message.reqId)?.();
      case 'listening':
        this.servers.announce({ port: message.port, url: message.url });
        return;
    }
  }

  private async forward(proc: Proc, port: number, request: HttpRequestData): Promise<HttpStreamResponse> {
    if (proc.exited) return textResponse(502, EXITED);
    const reqId = this.nextReq++;
    const response = proc.responses.expect(reqId, () => this.post(proc, { type: 'request-cancel', reqId }));
    this.post(proc, { type: 'http-request', reqId, port, request });
    return (await response) ?? textResponse(502, `Nothing is listening on port ${port}.`);
  }
}
