/**
 * The worker side of one Python process. It speaks the process Workers'
 * protocol (node/protocol.ts), so the page's process host drives it like any
 * other process: `prime`/`start` mount the project from the shared snapshot
 * pack (`mountSnapshot`/`applyOps`), `fs` ops flow both ways, stdout and stderr
 * stream as bytes, `exit` carries the code, `kill` ends it. A served app
 * announces its port with `listen` and answers each `http-request` through the
 * ASGI/WSGI adapter (node/servedPorts.ts, shared with Node's worker); a
 * `listen-failed` ends it, since another process owns the port. A successful
 * `pip install` is reported with `python-installed`.
 *
 * The start message's `python` field carries the host's instructions — where
 * Pyodide is served, extensions to install, the session's recorded packages —
 * never the environment, so a program cannot redirect them.
 *
 * No worker globals in here — `post`, the interpreter and module imports are
 * injected — so the same code runs in a real Worker (worker.ts) and in-thread
 * in tests.
 */
import { VirtualFileSystem, applyOps, mountSnapshot, signalExitCode, type VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, StartMessage, WorkerToHost } from '../../node/protocol.js';
import { createServedPorts } from '../../node/servedPorts.js';
import type { PythonAppServer } from './appServer.js';
import { installBfwcPackage } from './py/installBfwcPackage.js';
import { mapInvocationPaths, parsePythonCommand } from './pythonCommand.js';
import { importModule, installPythonExtensions, type ImportModule, type ProvidedPackages } from './pythonExtensions.js';
import { runPythonInvocation } from './pythonProgram.js';
import { applyOpsToPyodide, copyIntoPyodide, toPyodidePath, trackPyodideWrites, type PyodideWriteTracker } from './pyodideFs.js';
import type { PyodideLike } from './pyodideLoader.js';
import { createDialTransport } from './dialTransport.js';
import { installVirtualSockets, type VirtualTcpTransport } from './virtualSocket.js';

export interface PythonWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** A fresh interpreter (`loadPyodideRuntime` in a Worker; the `pyodide` npm package in tests). */
  loadPyodide(options: { indexURL?: string; env: Record<string, string> }): Promise<PyodideLike>;
  /** Virtual TCP for Python sockets. Default: the process protocol's dialled connections (dialTransport.ts). */
  tcp?: VirtualTcpTransport;
  /** How extension modules are imported. Default `import(url)`. */
  importModule?: ImportModule;
}

const addressInUse = (port: number) => `[Errno 98] error while attempting to bind on address ('0.0.0.0', ${port}): address already in use\n`;
const isFatal = (error: unknown) => /fatal error/i.test(error instanceof Error ? error.message : String(error));

export function createPythonWorkerProcess(deps: PythonWorkerProcessDeps): { receive(message: HostToWorker): void } {
  /** The project until Pyodide holds it: the snapshot mounts here, early ops land here. */
  let staging: VirtualFileSystem | undefined = new VirtualFileSystem();
  let pyodide: PyodideLike | undefined;
  let tracker: PyodideWriteTracker | undefined;
  let server: PythonAppServer | undefined;
  let serverPort: number | undefined;
  let exited = false;
  const stdin: string[] = [];
  const stdinDecoder = new TextDecoder();
  /** Python's sockets dial ports anywhere in the runtime (the Postgres gateway on 5432, another service). */
  const dialled = deps.tcp ? undefined : createDialTransport(deps.post);
  const tcp = deps.tcp ?? dialled!.transport;

  const out = (stream: 'stdout' | 'stderr') => (text: string) => {
    if (!exited) deps.post({ type: stream, data: text });
  };
  const io = {
    stdout: out('stdout'),
    stderr: out('stderr'),
    installed: (packages: { specs: string[]; indexUrls: string[] }) => deps.post({ type: 'python-installed', ...packages }),
  };

  /** A request to the served app; an interpreter that died fatally ends the process. */
  const answer = (request: Parameters<PythonAppServer['handle']>[0]) =>
    server!.handle(request).catch((error: unknown) => {
      if (isFatal(error)) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        exit(1);
      }
      throw error;
    });
  const served = createServedPorts({
    post: deps.post,
    handlerFor: (port) => (server && port === serverPort ? answer : undefined),
    onListenFailed(port) {
      if (port !== serverPort) return;
      io.stderr(addressInUse(port));
      serverPort = undefined; // never ours: nothing to unlisten
      void stop('SIGTERM', 1);
    },
  });

  const applyIncoming = (ops: readonly VfsOp[]) => {
    if (staging) return applyOps(staging, ops);
    if (pyodide && tracker) tracker.quietly(() => applyOpsToPyodide(pyodide!.FS, ops));
  };

  function exit(code: number): void {
    if (exited) return;
    tracker?.flush(); // every write reaches the page before the exit does
    exited = true;
    if (serverPort !== undefined) deps.post({ type: 'unlisten', port: serverPort });
    deps.post({ type: 'exit', code });
  }

  /** Pyodide up, the project copied in, writes tracked, stdio wired, `bfwc` and extensions installed, env and cwd set. */
  async function boot(message: StartMessage): Promise<{ py: PyodideLike; provided: ProvidedPackages }> {
    const env = { ...message.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PWD: toPyodidePath(message.cwd) };
    const py = await deps.loadPyodide({ indexURL: message.python?.indexURL, env });
    const write = (stream: 'stdout' | 'stderr') => ({
      write: (buffer: Uint8Array) => {
        if (!exited) deps.post({ type: stream, data: buffer.slice() });
        return buffer.length;
      },
      isatty: false,
    });
    py.setStdout(write('stdout'));
    py.setStderr(write('stderr'));
    // Input that has arrived, then end of file: a synchronous read cannot wait for more.
    py.setStdin({ stdin: () => stdin.shift() ?? null, isatty: false });
    // The runtime's own modules and the host's extensions go in before writes are tracked: none of it is the project's.
    installBfwcPackage(py);
    installVirtualSockets(py, tcp);
    const provided = await installPythonExtensions(py, message.python?.extensions ?? [], deps.importModule ?? importModule);
    copyIntoPyodide(staging!, py.FS);
    staging = undefined; // from here on, page ops go straight into Pyodide
    pyodide = py;
    tracker = trackPyodideWrites(py.FS, (ops) => {
      if (!exited) deps.post({ type: 'fs', ops });
    });
    const bootstrap = py.pyimport('bfwc.run').bootstrap as (env: unknown, cwd: string) => void;
    const pyEnv = py.toPy(env);
    try {
      bootstrap(pyEnv, toPyodidePath(message.cwd));
    } finally {
      pyEnv.destroy?.();
    }
    return { py, provided };
  }

  async function start(message: StartMessage): Promise<void> {
    const { snapshot } = message;
    if (snapshot.pack) mountSnapshot(staging!, snapshot);
    else applyIncoming(snapshot.ops);
    for (const port of message.ports) served.taken.add(port);
    const parsed = parsePythonCommand(message.command, message.args, message.env);
    if (!parsed.ok) {
      io.stderr(`${message.command}: ${parsed.reason}\n`);
      return exit(2);
    }
    const invocation = mapInvocationPaths(parsed.invocation, toPyodidePath);
    if (invocation.kind === 'serve' && served.taken.has(invocation.server.port)) {
      io.stderr(addressInUse(invocation.server.port));
      return exit(1);
    }
    const { py, provided } = await boot(message);
    if (exited) return; // killed while Pyodide loaded
    const outcome = await runPythonInvocation(py, invocation, {
      cwd: toPyodidePath(message.cwd),
      env: message.env,
      io,
      installs: message.python?.installs ?? [],
      provided,
    });
    if (outcome.kind === 'exited') return exit(outcome.code);
    const port = outcome.server.spec.port;
    // Another process may have taken the port while this one booted (the page tells every process).
    if (exited || served.taken.has(port)) {
      await outcome.server.close();
      if (!exited) io.stderr(addressInUse(port));
      return exit(1);
    }
    server = outcome.server;
    serverPort = port;
    served.taken.add(port);
    deps.post({ type: 'listen', port });
    io.stderr(`Serving ${server.spec.interface.toUpperCase()} app ${server.spec.app} on http://localhost:${port} (request-driven)\n`);
  }

  async function stop(signal: string, code = signalExitCode(signal)): Promise<void> {
    const running = server;
    server = undefined;
    served.cancelAll();
    try {
      await running?.close();
    } finally {
      exit(code);
    }
  }

  const pushStdin = (text: string) => stdin.push(...text.split(/(?<=\n)/).filter(Boolean));

  return {
    receive(message) {
      if (served.receive(message) || dialled?.receive(message)) return;
      switch (message.type) {
        case 'prime':
          mountSnapshot(staging!, message.snapshot);
          return deps.post({ type: 'primed' });
        case 'start':
          start(message).catch((error: unknown) => {
            io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
            exit(1);
          });
          return;
        case 'fs':
          return applyIncoming(message.ops);
        case 'kill':
          return void stop(message.signal);
        case 'stdin':
          return pushStdin(message.data === null ? stdinDecoder.decode() : typeof message.data === 'string' ? message.data : stdinDecoder.decode(message.data, { stream: true }));
        case 'socket-open':
        case 'socket-accept':
          // No WebSocket or raw-TCP servers in Python apps yet: refuse the connection.
          return deps.post({ type: 'socket-close', connId: message.connId });
        default:
          // Children, IPC, loopback responses: a Python process starts none of them.
          return;
      }
    },
  };
}
