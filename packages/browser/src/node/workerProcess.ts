/**
 * The worker side of one process: mirror the file system, build a `System`
 * whose spawn/listen/loopback are relayed to the page, run the program, and
 * stream its output back. No worker globals in here — `post` and the message
 * feed are injected — so the same code runs in a real Worker (worker.ts) and
 * in-thread in tests.
 */
import {
  VirtualFileSystem,
  commandNotFound,
  defaultPrograms,
  resolveCommand,
  runProgram,
  type ChildHandle,
  type FsChange,
  type HttpHandler,
  type HttpResponseData,
  type PackageCache,
  type System,
} from '@seanhogg/builderforce-webcontainers-core';
import type { FsOp, HostToWorker, StartMessage, WorkerToHost } from './protocol.js';
import { portPath } from './protocol.js';

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
  const handlers = new Map<number, HttpHandler>();
  const knownPorts = new Set<number>();
  const children = new Map<number, { stdout: Set<(s: string) => void>; stderr: Set<(s: string) => void>; exit: (code: number) => void }>();
  const loopbacks = new Map<number, (response: HttpResponseData | undefined) => void>();
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

  function remoteChild(command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; terminal?: { cols: number; rows: number } } = {}): ChildHandle {
    flush(); // the child must see every write made so far
    const childId = nextChild++;
    const stdout = new Set<(s: string) => void>();
    const stderr = new Set<(s: string) => void>();
    let resolveExit!: (code: number) => void;
    const exit = new Promise<number>((resolve) => (resolveExit = resolve));
    children.set(childId, { stdout, stderr, exit: resolveExit });
    deps.post({ type: 'spawn', childId, command, args, cwd: options.cwd, env: options.env, terminal: options.terminal });
    return {
      pid: childId,
      onStdout: (l) => (stdout.add(l), () => stdout.delete(l)),
      onStderr: (l) => (stderr.add(l), () => stderr.delete(l)),
      write: (data) => deps.post({ type: 'child-stdin', childId, data }),
      closeStdin: () => deps.post({ type: 'child-stdin', childId, data: null }),
      kill: (signal = 'SIGTERM') => deps.post({ type: 'child-kill', childId, signal }),
      resize: (cols, rows) => deps.post({ type: 'child-resize', childId, cols, rows }),
      exit,
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
      listen(port, handler) {
        let actual = port;
        if (!actual) for (actual = EPHEMERAL + (message.pid % 1000) * 8; knownPorts.has(actual); actual++);
        if (knownPorts.has(actual)) throw Object.assign(new Error(`listen EADDRINUSE: address already in use :::${actual}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', port: actual });
        knownPorts.add(actual);
        handlers.set(actual, handler);
        deps.post({ type: 'listen', port: actual });
        return {
          port: actual,
          close() {
            if (handlers.get(actual) !== handler) return;
            handlers.delete(actual);
            knownPorts.delete(actual);
            deps.post({ type: 'unlisten', port: actual });
          },
        };
      },
      loopback(port, request) {
        const local = handlers.get(port);
        if (local) return local(request);
        const reqId = nextReq++;
        return new Promise((resolve) => {
          loopbacks.set(reqId, resolve);
          deps.post({ type: 'loopback', reqId, port, request });
        });
      },
      serverUrl: (port) => new URL(portPath(message.previewBase, port), message.previewOrigin).href,
      announceServer: (port, url) => deps.post({ type: 'server-ready', port, url }),
      previewUrl: message.previewUrl,
      registry: message.registry,
      packageCache: message.packageCache ? deps.packageCache?.() : undefined,
      ownsRealm: deps.ownsRealm,
      trapUncaught: deps.trapUncaught,
    };

    const resolved = resolveCommand(fs, programs, message.command, message.args, message.cwd, message.env);
    if (!resolved) {
      deps.post({ type: 'stderr', data: `jsh: command not found: ${message.command}\n` });
      deps.post({ type: 'exit', code: 127 });
      return;
    }
    process = runProgram({ program: resolved.program, args: resolved.args, system, cwd: message.cwd, env: message.env, terminal: message.terminal, pid: message.pid });
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
          children.get(message.childId)?.exit(message.code);
          children.delete(message.childId);
          return;
        case 'child-error': {
          const child = children.get(message.childId);
          for (const l of child?.stderr ?? []) l(`${message.message}\n`);
          child?.exit(message.code === 'ENOENT' ? 127 : 1);
          children.delete(message.childId);
          return;
        }
        case 'http-request': {
          const handler = handlers.get(message.port);
          const respond = (response: HttpResponseData) => deps.post({ type: 'http-response', reqId: message.reqId, response });
          if (!handler) return respond({ status: 502, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(`Nothing is listening on port ${message.port}.`) });
          void handler(message.request).then(respond, (error: unknown) =>
            respond({ status: 500, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(String(error instanceof Error ? error.stack : error)) }),
          );
          return;
        }
        case 'loopback-response':
          loopbacks.get(message.reqId)?.(message.response ?? undefined);
          loopbacks.delete(message.reqId);
          return;
      }
    },
  };
}
