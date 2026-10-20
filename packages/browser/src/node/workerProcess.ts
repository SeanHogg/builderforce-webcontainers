/**
 * The worker side of one process: mirror the file system, build a `System`
 * whose spawn/listen/loopback are relayed to the page, run the program, and
 * stream its output back. Its servers' responses stream to the page as they
 * are written, and connections the page upgrades reach the server's `upgrade`
 * handler as a byte pipe. No worker globals in here — `post` and the message
 * feed are injected — so the same code runs in a real Worker (worker.ts) and
 * in-thread in tests.
 */
import {
  VirtualFileSystem,
  commandNotFound,
  createChannelPair,
  createIpcEndpoint,
  defaultPrograms,
  resolveCommand,
  runProgram,
  textResponse,
  type ByteChannel,
  type ChildHandle,
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
import { ResponseReceiver, sendResponse } from './responseWire.js';

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
  const handlers = new Map<number, { handler: HttpHandler; upgrade?: UpgradeHandler }>();
  const knownPorts = new Set<number>();
  const children = new Map<number, { stdout: Set<(chunk: StdioChunk) => void>; stderr: Set<(chunk: StdioChunk) => void>; exit: (code: number) => void; ipc?: ReturnType<typeof createIpcEndpoint> }>();
  /** This process's channel to its parent, when it was spawned with `ipc`. */
  let parentChannel: ReturnType<typeof createIpcEndpoint> | undefined;
  /** Responses to this process's loopback requests, streaming in from the page. */
  const loopbacks = new ResponseReceiver();
  /** Responses this process's servers are streaming to the page, by the page's request id. */
  const serving = new Map<number, () => void>();
  /** Upgraded connections the page opened, by its connection id (our end of the pipe to the server). */
  const sockets = new Map<number, ByteChannel>();
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
    if (change.type === 'write') pending.push({ op: 'write', path: change.path, content: fs.readFile(change.path)! });
    else pending.push({ op: change.type, path: change.path });
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  });

  const apply = (ops: FsOp[]) => {
    applying = true;
    try {
      for (const op of ops) {
        if (op.op === 'write') fs.writeFile(op.path, op.content);
        else if (op.op === 'mkdir') fs.mkdir(op.path);
        else fs.rm(op.path);
      }
    } finally {
      applying = false;
    }
  };

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
    applying = true;
    for (const dir of message.dirs) fs.mkdir(dir);
    for (const [path, content] of message.files) fs.writeFile(path, content);
    applying = false;
    for (const port of message.ports) knownPorts.add(port);

    const system: System = {
      fs,
      fetch: deps.fetch,
      spawn(command, args, options = {}) {
        // Resolve here, against the mirror, so a missing command fails synchronously
        // with ENOENT exactly as it does in-process.
        const cwd = options.cwd ?? message.cwd;
        const env = { ...message.env, ...options.env };
        if (!resolveCommand(fs, programs, command, args, cwd, env)) throw commandNotFound(command);
        return remoteChild(command, args, { ...options, cwd, env });
      },
      listen(port, handler, upgrade) {
        let actual = port;
        if (!actual) for (actual = EPHEMERAL + (message.pid % 1000) * 8; knownPorts.has(actual); actual++);
        if (knownPorts.has(actual)) throw Object.assign(new Error(`listen EADDRINUSE: address already in use :::${actual}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', port: actual });
        knownPorts.add(actual);
        const entry = { handler, upgrade };
        handlers.set(actual, entry);
        deps.post({ type: 'listen', port: actual });
        return {
          port: actual,
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
      switch (message.type) {
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
        case 'ports':
          for (const port of message.open) knownPorts.add(port);
          for (const port of message.closed) if (!handlers.has(port)) knownPorts.delete(port);
          return;
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
        case 'http-request': {
          const { reqId } = message;
          const entry = handlers.get(message.port);
          const response = entry ? entry.handler(message.request) : Promise.resolve(textResponse(502, `Nothing is listening on port ${message.port}.`));
          serving.set(reqId, sendResponse(deps.post, reqId, response, () => serving.delete(reqId)));
          return;
        }
        case 'request-cancel':
          return serving.get(message.reqId)?.();
        case 'response-head':
        case 'response-chunk':
        case 'response-end':
          return loopbacks.receive(message);
        case 'socket-open': {
          const { connId } = message;
          const upgrade = handlers.get(message.port)?.upgrade;
          if (!upgrade) return deps.post({ type: 'socket-close', connId });
          const [ours, server] = createChannelPair();
          sockets.set(connId, ours);
          ours.onData((data) => deps.post({ type: 'socket-data', connId, data }));
          ours.onClose(() => {
            sockets.delete(connId);
            deps.post({ type: 'socket-close', connId });
          });
          upgrade(message.request, server);
          return;
        }
        case 'socket-data':
          return sockets.get(message.connId)?.send(message.data);
        case 'socket-close':
          sockets.get(message.connId)?.close();
          sockets.delete(message.connId);
          return;
      }
    },
  };
}
