/**
 * The worker side of one process: mirror the file system (mounted from the
 * start snapshot's pack, contents read on first open), build a `System`
 * whose spawn/listen/loopback are relayed to the page, run the program, and
 * stream its output back. Its servers' responses stream to the page as they
 * are written, and connections the page upgrades reach the server's `upgrade`
 * handler as a byte pipe. No worker globals in here — `post` and the message
 * feed are injected — so the same code runs in a real Worker (worker.ts) and
 * in-thread in tests.
 */
import {
  VirtualFileSystem,
  acceptConnection,
  addressInUseError,
  applyOps,
  basename,
  changeToOp,
  commandNotFound,
  createIpcEndpoint,
  defaultPrograms,
  mountSnapshot,
  resolveCommand,
  runProgram,
  type ChildHandle,
  type ConnectionHandler,
  type FsChange,
  type HttpHandler,
  type PackageCache,
  type ProcessOptions,
  type StdioChunk,
  type System,
  type UpgradeHandler,
} from '@seanhogg/builderforce-webcontainers-core';
import type { FsOp, HostToWorker, StartMessage, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';
import { ResponseReceiver } from './responseWire.js';
import { createServedPorts } from './servedPorts.js';
import { createWorkerConnections, isWorkerConnectionMessage } from './workerConnections.js';

export interface WorkerProcessDeps {
  post(message: WorkerToHost): void;
  fetch: System['fetch'];
  packageCache?: () => PackageCache | undefined;
  /** Register for the realm's uncaught errors (a real worker's `error`/`unhandledrejection`). */
  trapUncaught?(handler: (error: unknown) => void): () => void;
  /** This process has the realm to itself (true in a real Worker). */
  ownsRealm?: boolean;
}

const EPHEMERAL = 49152;

export function createWorkerProcess(deps: WorkerProcessDeps): { receive(message: HostToWorker): void } {
  const fs = new VirtualFileSystem();
  const handlers = new Map<number, { handler: HttpHandler; upgrade?: UpgradeHandler; accept?: ConnectionHandler }>();
  /** Listens the page has not answered yet, by id: the entry they registered and how to settle `ready`. */
  const awaiting = new Map<number, { port: number; entry: object; settle(error?: Error): void }>();
  let nextListen = 1;
  const answered = (id: number | undefined, error?: Error) => {
    const listen = id === undefined ? undefined : awaiting.get(id);
    if (!listen) return;
    awaiting.delete(id!);
    // Only the registration the page refused goes: a later listen on the same port is not touched.
    if (error && handlers.get(listen.port) === listen.entry) handlers.delete(listen.port);
    listen.settle(error);
  };
  const served = createServedPorts({
    post: deps.post,
    handlerFor: (port) => handlers.get(port)?.handler,
    // Another process holds the port: the server hears EADDRINUSE through its 'error' event, as in Node.
    onListenFailed: (port, _message, id) => answered(id, addressInUseError(port)),
    onListened: (_port, id) => answered(id),
  });
  const knownPorts = served.taken;
  const children = new Map<number, { stdout: Set<(chunk: StdioChunk) => void>; stderr: Set<(chunk: StdioChunk) => void>; exit: (code: number) => void; ipc?: ReturnType<typeof createIpcEndpoint> }>();
  /** This process's channel to its parent, when it was spawned with `ipc`. */
  let parentChannel: ReturnType<typeof createIpcEndpoint> | undefined;
  /** Responses to this process's loopback requests, streaming in from the page. */
  const loopbacks = new ResponseReceiver();
  /** Connections to this process's servers, and the ones it dials. */
  const connections = createWorkerConnections(deps.post);
  let nextChild = 1;
  let nextReq = 1;
  let applying = false;
  let pending: FsOp[] = [];
  let flushScheduled = false;
  let process: ChildHandle | undefined;
  const programs = defaultPrograms();

  const flush = () => {
    flushScheduled = false;
    if (!pending.length) return;
    const ops = pending;
    pending = [];
    deps.post({ type: 'fs', ops });
  };

  fs.watch((change: FsChange) => {
    if (applying) return;
    pending.push(changeToOp(fs, change));
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }, { promotions: true }); // a directory made explicit here must outlive its files on the page too

  /** Apply the page's changes (or mount the start snapshot) without echoing them back. */
  const quietly = (load: () => void) => {
    applying = true;
    try {
      load();
    } finally {
      applying = false;
    }
  };
  const apply = (ops: FsOp[]) => quietly(() => applyOps(fs, ops));

  function remoteChild(command: string, args: string[], options: ProcessOptions = {}): ChildHandle {
    flush(); // the child must see every write made so far
    const childId = nextChild++;
    const stdout = new Set<(chunk: StdioChunk) => void>();
    const stderr = new Set<(chunk: StdioChunk) => void>();
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    const ipc = options.ipc
      ? createIpcEndpoint((data) => deps.post({ type: 'child-ipc', childId, data }), () => deps.post({ type: 'child-ipc-disconnect', childId }))
      : undefined;
    children.set(childId, { stdout, stderr, exit: resolveExit, ipc });
    deps.post({ type: 'spawn', childId, command, args, cwd: options.cwd, env: options.env, terminal: options.terminal, ipc: options.ipc, thread: options.thread, detached: options.detached });
    return {
      pid: childId,
      onStdout: (l) => (stdout.add(l), () => stdout.delete(l)),
      onStderr: (l) => (stderr.add(l), () => stderr.delete(l)),
      write: (data) => deps.post({ type: 'child-stdin', childId, data }),
      closeStdin: () => deps.post({ type: 'child-stdin', childId, data: null }),
      kill: (signal = 'SIGTERM') => deps.post({ type: 'child-kill', childId, signal }),
      resize: (cols, rows) => deps.post({ type: 'child-resize', childId, cols, rows }),
      exit,
      ipc: ipc?.endpoint,
    };
  }

  function start(message: StartMessage): void {
    const { snapshot } = message;
    quietly(() => (snapshot.pack ? mountSnapshot(fs, snapshot) : applyOps(fs, snapshot.ops)));
    for (const port of message.ports) knownPorts.add(port);
    /** Commands another Worker kind runs (Python): spawned through the page, never resolved here. */
    const foreign = message.foreignCommands ? new RegExp(message.foreignCommands) : undefined;

    const system: System = {
      fs,
      fetch: deps.fetch,
      spawn(command, args, options = {}) {
        // Resolve here, against the mirror, so a missing command fails synchronously
        // with ENOENT exactly as it does in-process. Python commands run in a Python
        // process Worker the page starts for them.
        const cwd = options.cwd ?? message.cwd;
        const env = { ...message.env, ...options.env };
        if (!foreign?.test(basename(command)) && !resolveCommand(fs, programs, command, args, cwd, env)) throw commandNotFound(command);
        return remoteChild(command, args, { ...options, cwd, env });
      },
      listen(port, handler, upgrade, accept) {
        let actual = port;
        if (!actual) for (actual = EPHEMERAL + (message.pid % 1000) * 8; knownPorts.has(actual); actual++);
        if (knownPorts.has(actual)) throw addressInUseError(actual);
        knownPorts.add(actual);
        const entry = { handler, upgrade, accept };
        handlers.set(actual, entry);
        const id = nextListen++;
        // Settled by the page's answer: another process may have taken the port first.
        const ready = new Promise<void>((resolve, reject) => awaiting.set(id, { port: actual, entry, settle: (error) => (error ? reject(error) : resolve()) }));
        ready.catch(() => undefined); // a caller that never looks must not see an unhandled rejection
        deps.post({ type: 'listen', port: actual, tcp: accept !== undefined, id });
        return {
          port: actual,
          ready,
          close() {
            if (handlers.get(actual) !== entry) return;
            handlers.delete(actual);
            knownPorts.delete(actual);
            deps.post({ type: 'unlisten', port: actual });
          },
        };
      },
      loopback(port, request) {
        const local = handlers.get(port);
        if (local) return local.handler(request);
        const reqId = nextReq++;
        const response = loopbacks.expect(reqId, () => deps.post({ type: 'request-cancel', reqId }));
        deps.post({ type: 'loopback', reqId, port, request });
        return response;
      },
      async connect(port) {
        const local = handlers.get(port);
        return local ? acceptConnection(local.accept) : connections.dial(port);
      },
      serverUrl: (port) => new URL(portPath(message.previewBase, port), message.previewOrigin).href,
      announceServer: (port, url) => deps.post({ type: 'listening', port, url }),
      previewUrl: message.previewUrl,
      registry: message.registry,
      packageCache: message.packageCache ? deps.packageCache?.() : undefined,
      ownsRealm: deps.ownsRealm,
      trapUncaught: deps.trapUncaught,
    };

    const resolved = resolveCommand(fs, programs, message.command, message.args, message.cwd, message.env);
    if (!resolved) {
      deps.post({ type: 'stderr', data: `bfsh: command not found: ${message.command}\n` });
      deps.post({ type: 'exit', code: 127 });
      return;
    }
    if (message.ipc) parentChannel = createIpcEndpoint((data) => deps.post({ type: 'ipc', data }), () => deps.post({ type: 'ipc-disconnect' }));
    process = runProgram({
      program: resolved.program,
      args: resolved.args,
      system,
      cwd: message.cwd,
      env: message.env,
      terminal: message.terminal,
      pid: message.pid,
      thread: message.thread,
      channel: parentChannel?.endpoint,
    });
    process.onStdout((data) => deps.post({ type: 'stdout', data }));
    process.onStderr((data) => deps.post({ type: 'stderr', data }));
    void process.exit.then((code) => {
      flush();
      deps.post({ type: 'exit', code });
    });
  }

  return {
    receive(message) {
      if (served.receive(message)) return;
      switch (message.type) {
        case 'prime':
          quietly(() => mountSnapshot(fs, message.snapshot));
          return deps.post({ type: 'primed' });
        case 'start':
          return start(message);
        case 'stdin':
          if (message.data === null) process?.closeStdin();
          else process?.write(message.data);
          return;
        case 'kill':
          return process?.kill(message.signal);
        case 'resize':
          return process?.resize?.(message.cols, message.rows);
        case 'fs':
          return apply(message.ops);
        case 'child-out':
          for (const l of children.get(message.childId)?.[message.stream] ?? []) l(message.data);
          return;
        case 'child-exit':
          children.get(message.childId)?.ipc?.closed();
          children.get(message.childId)?.exit(message.code);
          children.delete(message.childId);
          return;
        case 'child-ipc':
          return children.get(message.childId)?.ipc?.receive(message.data);
        case 'child-ipc-disconnect':
          return children.get(message.childId)?.ipc?.closed();
        case 'ipc':
          return parentChannel?.receive(message.data);
        case 'ipc-disconnect':
          return parentChannel?.closed();
        case 'child-error': {
          const child = children.get(message.childId);
          for (const l of child?.stderr ?? []) l(`${message.message}\n`);
          child?.exit(message.code === 'ENOENT' ? 127 : 1);
          children.delete(message.childId);
          return;
        }
        case 'response-head':
        case 'response-chunk':
        case 'response-end':
          return loopbacks.receive(message);
        case 'socket-open':
          return connections.upgraded(message.connId, message.request, handlers.get(message.port)?.upgrade);
        case 'socket-accept':
          return connections.accepted(message.connId, handlers.get(message.port));
        default:
          if (isWorkerConnectionMessage(message)) return connections.receive(message);
      }
    },
  };
}
