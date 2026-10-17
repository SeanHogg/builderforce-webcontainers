/**
 * The page side of the Node runtime: one Web Worker per process. The page owns
 * the master file system and the port table; each worker gets a snapshot of
 * the files at start, and writes flow both ways as batched ops (a worker's
 * write reaches the page, then every other worker). Children a worker spawns
 * (the shell running `node`, `child_process`) are started here too, so every
 * process — however deep — can be killed by terminating its worker.
 *
 * Responses from a worker's servers stream through here chunk by chunk (see
 * responseWire.ts), and upgraded connections (WebSockets) are relayed as raw
 * bytes between the client end the caller holds and the server's worker.
 */
import {
  DEFAULT_ENV,
  PortRegistry,
  ServerEvents,
  allocatePid,
  runArguments,
  textResponse,
  toRuntimeProcess,
  type ByteChannel,
  type ChildHandle,
  type FsChange,
  type HttpRequestData,
  type HttpResponseData,
  type HttpStreamResponse,
  type ProcessOptions,
  type RuntimeProcess,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';
import type { FsOp, HostToWorker, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';
import { ResponseReceiver, sendResponse } from './responseWire.js';

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
  stdout: Set<(chunk: string) => void>;
  stderr: Set<(chunk: string) => void>;
  exited: boolean;
  resolveExit(code: number): void;
  registrations: Map<number, { close(): void }>;
  children: Map<number, ChildHandle>;
  /** Responses its servers are streaming back to requests forwarded here. */
  responses: ResponseReceiver;
  /** Its loopback requests being answered, by the worker's request id: cancel functions. */
  loopbacks: Map<number, () => void>;
  /** Upgraded connections to its servers: the page-side end of each, by connection id. */
  sockets: Map<number, ByteChannel>;
  outbox: FsOp[];
}

const EXITED = 'The server process exited.';

export class ProcessHost {
  readonly ports = new PortRegistry();
  /** Servers listening, ports opening and closing. */
  readonly servers = new ServerEvents();
  private readonly procs = new Set<Proc>();
  private applyingFrom?: Proc;
  private flushScheduled = false;
  private nextReq = 1;
  private nextConn = 1;
  private readonly unwatch: () => void;
  private readonly stopPorts: () => void;

  constructor(private readonly options: ProcessHostOptions) {
    this.unwatch = options.fs.watch((change) => this.onFsChange(change));
    this.stopPorts = this.ports.watch(({ type, port }) => {
      const url = this.serverUrl(port);
      for (const proc of this.procs) this.post(proc, { type: 'ports', open: type === 'open' ? [port] : [], closed: type === 'close' ? [port] : [] });
      this.servers.portChanged({ type, port, url });
    });
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
    const worker = this.options.createWorker();
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    const proc: Proc = {
      pid,
      info: { pid, command, args: [...args], cwd: options.cwd ?? '/', startedAt: Date.now() },
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
      responses: new ResponseReceiver(),
      loopbacks: new Map(),
      sockets: new Map(),
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
    proc.responses.abort(() => textResponse(502, EXITED), EXITED);
    for (const cancel of [...proc.loopbacks.values()]) cancel();
    proc.loopbacks.clear();
    for (const socket of proc.sockets.values()) socket.close();
    proc.sockets.clear();
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
          const registration = this.ports.listen(
            message.port,
            (request) => this.forward(proc, message.port, request),
            (request, socket) => this.forwardUpgrade(proc, message.port, request, socket),
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
      case 'socket-data':
        return proc.sockets.get(message.connId)?.send(message.data);
      case 'socket-close':
        proc.sockets.get(message.connId)?.close();
        proc.sockets.delete(message.connId);
        return;
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

  /** Relay an upgraded connection: `socket` is the server end; its bytes go to the worker, and the worker's come back. */
  private forwardUpgrade(proc: Proc, port: number, request: HttpRequestData, socket: ByteChannel): void {
    if (proc.exited) return socket.close();
    const connId = this.nextConn++;
    proc.sockets.set(connId, socket);
    socket.onData((data) => this.post(proc, { type: 'socket-data', connId, data }));
    socket.onClose(() => {
      if (proc.sockets.delete(connId)) this.post(proc, { type: 'socket-close', connId });
    });
    this.post(proc, { type: 'socket-open', connId, port, request });
  }
}
