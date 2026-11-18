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
 * A process's Worker kind follows its command, as the host's `ProcessKindPolicy`
 * routes it (processKinds.ts): with the Python runtime's policy, Python
 * commands run in a Python process Worker, everything else in a Node one. Both
 * speak the same protocol, so a shell's `python app.py` or Node's
 * `spawn('python')` is just another child.
 *
 * Responses from a worker's servers stream through here chunk by chunk (see
 * responseWire.ts); connections — upgraded (WebSockets) and raw TCP, to a
 * worker's servers or dialled by it — are relayed as raw bytes (connectionRelay.ts).
 * Each process's identity is assigned here at spawn (processIdentity.ts): its ports,
 * loopbacks and dials carry it, its application's quota admits it, and an application
 * process sees only its service's view of the file system (fsScope.ts).
 */
import {
  DEFAULT_ENV,
  PortRegistry,
  ServerEvents,
  PLATFORM_CONTEXT,
  allocatePid,
  bufferResponse,
  createIpcEndpoint,
  runArguments,
  signalExitCode,
  toRuntimeProcess,
  type ByteChannel,
  type ChildHandle,
  type HttpRequestData,
  type HttpResponseData,
  type HttpStreamResponse,
  type ProcessOptions,
  type RuntimeProcess,
  type SecurityContext,
  type ShieldDecision,
  type VfsSnapshots,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';
import { ServiceGraphPolicy } from '@seanhogg/builderforce-webcontainers-core/app';
import type { HostToWorker, WorkerKind, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';
import { NODE_ONLY, type ProcessKindPolicy } from './processKinds.js';
import { ResponseReceiver } from './responseWire.js';
import { ChildRelay, isChildMessage } from './childRelay.js';
import { ConnectionRelay, isConnectionMessage } from './connectionRelay.js';
import { WorkerSupply } from './workerSupply.js';
import { FsSync } from './fsSync.js';
import { ProcessIdentities, type ProcessShieldOptions, type SpawnOptions, type SpawnOrigin } from './processIdentity.js';
import { ProcessPorts } from './processPorts.js';
import { opEvidence } from './fsScope.js';
import { IngressLimit } from '../security/ingressLimit.js';
import { ViewSupplies } from './viewSupply.js';
import type { Proc } from './procRecord.js';

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
  /** A process Worker of `kind` (as `kinds` routes the command), for an application's process (`applicationId`) or the workspace's (undefined). */
  createWorker(kind: WorkerKind, applicationId?: string): WorkerLike;
  /** Which Worker kind runs a command, and what that kind needs. Default: every process is Node. */
  kinds?: ProcessKindPolicy;
  /** Origin and base path previews are served under (`/__bfwc/<id>/`). */
  previewOrigin: string;
  /** The preview origin of an application's processes and ports (W10 control 1). Default: `previewOrigin` for all. Throws to refuse the application. */
  previewOriginOf?(applicationId: string): string;
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
  /** Process quotas, file-system views and the decisions they report (Security Shield). */
  security?: ProcessShieldOptions;
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

export class ProcessHost {
  /** The port policy: applications register their service graph here (`startApplicationRuntime`'s `portPolicy`). */
  readonly portPolicy = new ServiceGraphPolicy();
  /** Its refusals go to the shield's telemetry as the page-side caller. */
  readonly ports: PortRegistry;
  /** The request-body limit on loopback and host-API HTTP (control 3; the service worker bounds its own path). */
  private readonly ingress: IngressLimit;
  /** Servers listening, ports opening and closing. */
  readonly servers = new ServerEvents();
  private readonly procs = new Set<Proc>();
  private readonly stopPorts: () => void;
  /** Each process's servers and loopback requests, as itself. */
  private readonly served: ProcessPorts;
  /** Application processes' Workers and snapshots, per file-system view. */
  private readonly views: ViewSupplies;
  /** The processes' file systems kept in step with the page's, and the snapshots new ones start from. */
  private readonly fsSync: FsSync<Proc>;
  /** New processes' Workers: a primed spare when there is one, else a new Worker and the snapshot. */
  readonly workers: WorkerSupply;
  private readonly kinds: ProcessKindPolicy;
  /** Who each process is, its application's quota and its view of the file system. */
  private readonly identities: ProcessIdentities;

  constructor(private readonly options: ProcessHostOptions) {
    this.kinds = options.kinds ?? NODE_ONLY;
    const telemetry = options.security?.telemetry;
    this.ports = new PortRegistry({ policy: this.portPolicy, onDecision: telemetry?.portDecision });
    this.ingress = new IngressLimit({ telemetry, maxBodyBytes: options.security?.maxBodyBytes });
    this.identities = new ProcessIdentities(options.cwd ?? '/', options.security);
    const onRefused = (context: SecurityContext | undefined, op: unknown, decision: ShieldDecision) => context && this.identities.report(context, decision, opEvidence(op));
    this.fsSync = new FsSync(options.fs, { send: (proc, ops) => this.post(proc, { type: 'fs', ops }), onRefused });
    this.workers = new WorkerSupply((kind) => options.createWorker(kind), this.fsSync.snapshots, options.warmWorker !== false);
    // An application's Workers start on its own preview origin when it has one.
    this.views = new ViewSupplies(options.fs, (kind, applicationId) => options.createWorker(kind, applicationId), options.warmWorker !== false);
    this.served = new ProcessPorts(this.ports, (proc, message) => this.post(proc, message), (pid) => this.identityOf(pid), this.ingress);
    this.stopPorts = this.ports.watch(({ type, port }) => {
      const url = this.serverUrl(port);
      // Only to processes that may reach it: a process cannot list ports its policy hides (W10 control 4).
      for (const proc of this.procs) {
        const caller = this.identityOf(proc.pid);
        if (caller && this.ports.reaches(port, caller)) this.post(proc, { type: 'ports', open: type === 'open' ? [port] : [], closed: type === 'close' ? [port] : [] });
      }
      this.servers.portChanged({ type, port, url });
    });
  }

  /** What each new process starts from: one pack reused until the project outgrows it, plus the ops since. */
  get snapshots(): VfsSnapshots {
    return this.fsSync.snapshots;
  }

  serverUrl(port: number): string {
    return new URL(portPath(this.options.previewBase, port), this.originOf(this.ports.ownerOf(port)?.applicationId)).href;
  }

  /** The preview origin an application's processes and ports use (the shared one for the workspace and the platform). */
  private originOf(applicationId: string | undefined): string {
    return applicationId === undefined || !this.options.previewOriginOf ? this.options.previewOrigin : this.options.previewOriginOf(applicationId);
  }

  /** Start a command in its own Web Worker, as a stream-based {@link RuntimeProcess}. */
  run(command: string, args?: string[], options?: SpawnOptions): RuntimeProcess;
  run(command: string, options?: SpawnOptions): RuntimeProcess;
  run(command: string, argsOrOptions?: string[] | SpawnOptions, maybeOptions?: SpawnOptions): RuntimeProcess {
    const [args, options] = runArguments(argsOrOptions, maybeOptions) as [string[], SpawnOptions];
    return toRuntimeProcess(this.spawnChild(command, args, options), !!options.terminal);
  }

  /** A page-side start: the process is `options.identity` (default `workspace`). Throws EAGAIN when its application is over quota. */
  spawnChild(requested: string, requestedArgs: string[] = [], options: SpawnOptions = {}): ChildHandle {
    return this.spawn({ identity: options.identity }, requested, requestedArgs, options);
  }

  /** Who process `pid` is, as the page assigned it; undefined once it exited. */
  identityOf(pid: number): SecurityContext | undefined {
    return this.identities.identityOf(pid);
  }

  /** End every process of an application (of one of its services, given `serviceId`) now — `detached` ones included. */
  killApplication(applicationId: string, serviceId?: string): void {
    for (const proc of [...this.procs]) if (this.identities.attributedTo(proc.pid, applicationId, serviceId)) this.terminate(proc, signalExitCode('SIGKILL'));
    // The whole application ended: its views' mirrors, snapshots and warm spares go too (rebuilt if it spawns again).
    if (serviceId === undefined) this.views.release(applicationId);
  }

  private spawn(origin: SpawnOrigin, requested: string, requestedArgs: string[], options: ProcessOptions): ChildHandle {
    const cwd = options.cwd ?? this.options.cwd ?? '/';
    const admitted = this.identities.admit(origin, cwd);
    // Decided before the process exists: an application refused a preview origin (previewOriginOf throws) leaves no record behind.
    const previewOrigin = this.originOf(admitted.context.applicationId);
    const pid = allocatePid();
    const env = { ...DEFAULT_ENV, ...this.options.env, ...options.env };
    // An application process's command is routed (shebangs, scripts read) on its view's mirror: nothing outside its subtree is read for it.
    const routeFs = admitted.view ? this.views.mirrorFor(admitted.view) : this.options.fs;
    const { kind, command, args } = this.kinds.route(requested, requestedArgs, { fs: routeFs, cwd, env });
    // An application process starts from its own view's supply: nothing outside the view is in its pack or spare.
    const { worker, snapshot } = (admitted.view ? this.views.supplyFor(admitted.view) : this.workers).take(kind);
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    const proc: Proc = {
      pid,
      kind,
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
        return this.spawn({ parent: pid }, childCommand, childArgs, childOptions); // its parent's identity, whatever the Worker asked
      }, (message) => this.post(proc, message)),
      responses: new ResponseReceiver(),
      loopbacks: new Map(),
      connections: new ConnectionRelay(this.ports, (message) => this.post(proc, message), { pid, identityOf: (of) => this.identityOf(of) }),
    };
    if (options.ipc) proc.ipc = createIpcEndpoint((data) => this.post(proc, { type: 'ipc', data }), () => this.post(proc, { type: 'ipc-disconnect' }));
    this.identities.register(pid, admitted);
    this.procs.add(proc);
    this.fsSync.add(proc, { view: admitted.view, context: this.identityOf(pid) });
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
      env,
      terminal: options.terminal,
      ipc: options.ipc,
      thread: options.thread,
      snapshot,
      ports: ((self) => (self ? this.ports.reachablePorts(self) : []))(this.identityOf(pid)), // only what it may reach (W10 control 4)
      previewOrigin,
      previewBase: this.options.previewBase,
      previewUrl: this.options.previewUrl,
      registry: this.options.registry,
      // The shared tarball cache is off for application processes: one application must not seed another's installs.
      packageCache: this.options.packageCache !== false && !admitted.view,
      foreignCommands: this.kinds.foreignCommands,
      ...this.kinds.startOptions(kind, this.identityOf(pid) ?? admitted.context),
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

  /** Post a process-kind message (a training checkpoint, a save acknowledgement) to process `pid`; false when it is gone. */
  notify(pid: number, message: HostToWorker): boolean {
    const proc = [...this.procs].find((candidate) => candidate.pid === pid);
    if (!proc || proc.exited) return false;
    this.post(proc, message);
    return true;
  }

  /** Every process still running, oldest first — children started by a shell included. */
  list(): ProcessInfo[] {
    return [...this.procs].map((proc) => ({ ...proc.info, args: [...proc.info.args], ports: [...proc.registrations.keys()] }));
  }

  /** Dispatch an HTTP request to the server on `port` and wait for the whole response. `caller`: who asks (the port registry decides). A body over the limit is answered 413. */
  async request(port: number, request: HttpRequestData, caller?: SecurityContext): Promise<HttpResponseData | undefined> {
    const refused = this.ingress.refuse(port, request, caller ?? PLATFORM_CONTEXT, 'host');
    return refused ? bufferResponse(refused) : this.ports.requestBuffered(port, request, caller);
  }

  /** Dispatch an HTTP request to the server on `port` (the preview's `/__port/<port>/` path); resolves at the head, the body streaming. A body over the limit is answered 413. */
  async requestStream(port: number, request: HttpRequestData, caller?: SecurityContext): Promise<HttpStreamResponse | undefined> {
    return this.ingress.refuse(port, request, caller ?? PLATFORM_CONTEXT, 'host') ?? this.ports.request(port, request, caller);
  }

  /** Open an upgraded connection (a WebSocket) to the server on `port`; returns the client end. */
  upgrade(port: number, request: HttpRequestData, caller?: SecurityContext): ByteChannel | undefined {
    return this.ports.upgrade(port, request, caller);
  }

  dispose(): void {
    for (const proc of [...this.procs]) this.terminate(proc, signalExitCode('SIGKILL'));
    this.stopPorts();
    this.workers.dispose();
    this.views.dispose();
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
    this.served.close(proc);
    proc.connections.closeAll();
    proc.ipc?.closed();
    // Exited on its own: its children get SIGTERM (and the grace period), as a real parent's would.
    proc.children.killAll('SIGTERM');
    this.procs.delete(proc);
    this.identities.release(proc.pid);
    this.kinds.exited(proc.pid);
    this.fsSync.remove(proc);
    queueMicrotask(() => proc.worker.terminate());
  }

  private post(proc: Proc, message: HostToWorker): void {
    if (!proc.exited || message.type === 'start') proc.worker.postMessage(message);
  }

  private onWorkerMessage(proc: Proc, message: WorkerToHost): void {
    if (proc.exited) return; // its record is gone: a late message is never applied unscoped or unowned
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
      case 'listen':
        return this.served.listen(proc, message);
      case 'unlisten':
        return this.served.unlisten(proc, message.port);
      case 'response-head':
      case 'response-chunk':
      case 'response-end':
        return proc.responses.receive(message);
      case 'loopback':
        return this.served.loopback(proc, message);
      case 'request-cancel':
        return proc.loopbacks.get(message.reqId)?.();
      case 'listening': {
        // The URL is the page's, never the Worker's: a port this process registered is served at its owner's
        // preview origin (serverUrl); anything else is the dev-server handoff, served at the runtime's preview URL.
        const port = Number(message.port);
        const url = proc.registrations.has(port) ? this.serverUrl(port) : this.options.previewUrl;
        if (url && Number.isInteger(port) && port > 0 && port < 65536) this.servers.announce({ port, url });
        return;
      }
      default:
        // A message of one process kind (python-installed): its policy decides, knowing who sent it — from the
        // page-side record of this Worker, never the message. Each application writes only its own record
        // (keyed by its applicationId), so one cannot seed another's (or the terminal's) installs.
        {
          const identity = this.identityOf(proc.pid);
          if (identity) this.kinds.receive(proc.kind, message, identity);
        }
    }
  }
}
