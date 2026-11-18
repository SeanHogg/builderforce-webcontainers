/**
 * The worker side of one Python process: the shared interpreter-process
 * skeleton (runtimes/interpreterProcess.ts — the process protocol, the staged
 * project, served ports, exit and kill) with Pyodide as the interpreter. A
 * served app answers each `http-request` through the ASGI/WSGI adapter; an
 * interpreter that dies fatally while serving ends the process. A successful
 * `pip install` is reported with `python-installed`. Standard input is what
 * has arrived, then end of file.
 *
 * The start message's `python` field carries the host's instructions — where
 * Pyodide is served, extensions to install, the session's recorded packages —
 * never the environment, so a program cannot redirect them.
 *
 * No worker globals in here — `post`, the interpreter and module imports are
 * injected — so the same code runs in a real Worker (worker.ts) and in-thread
 * in tests.
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, StartMessage, WorkerToHost } from '../../node/protocol.js';
import { createInterpreterProcess, type InterpreterContext, type InterpreterOutcome } from '../interpreterProcess.js';
import type { PythonAppServer } from './appServer.js';
import { installBfwcPackage } from './py/installBfwcPackage.js';
import { mapInvocationPaths, parsePythonCommand, type PythonInvocation } from './pythonCommand.js';
import { importModule, installPythonExtensions, type ImportModule, type ProvidedPackages } from './pythonExtensions.js';
import { runPythonInvocation } from './pythonProgram.js';
import { applyOpsToPyodide, copyIntoPyodide, toPyodidePath, trackPyodideWrites } from './pyodideFs.js';
import type { PyodideLike } from './pyodideLoader.js';
import { createDialTransport } from './dialTransport.js';
import { installVirtualSockets, type VirtualTcpTransport } from './virtualSocket.js';
import { createTrainingArtifactStore, type TrainingArtifactStore } from './trainingArtifacts.js';
import { createTrainingControl } from './trainingControl.js';

export interface PythonWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** A fresh interpreter (`loadPyodideRuntime` in a Worker; the `pyodide` npm package in tests). */
  loadPyodide(options: { indexURL?: string; env: Record<string, string> }): Promise<PyodideLike>;
  /** Virtual TCP for Python sockets. Default: the process protocol's dialled connections (dialTransport.ts). */
  tcp?: VirtualTcpTransport;
  /** How extension modules are imported. Default `import(url)`. */
  importModule?: ImportModule;
  /** Where training artifacts are kept, outside the VFS. Default: IndexedDB (trainingArtifacts.ts). */
  artifacts?: TrainingArtifactStore;
}

const addressInUse = (port: number) => `[Errno 98] error while attempting to bind on address ('0.0.0.0', ${port}): address already in use\n`;
const isFatal = (error: unknown) => /fatal error/i.test(error instanceof Error ? error.message : String(error));

export function createPythonWorkerProcess(deps: PythonWorkerProcessDeps): { receive(message: HostToWorker): void } {
  const stdin: string[] = [];
  const stdinDecoder = new TextDecoder();
  /** Python's sockets dial ports anywhere in the runtime (the Postgres gateway on 5432, another service). */
  const dialled = deps.tcp ? undefined : createDialTransport(deps.post);
  const tcp = deps.tcp ?? dialled!.transport;
  const training = createTrainingControl(() => (deps.artifacts ??= createTrainingArtifactStore()));
  const pushStdin = (text: string) => stdin.push(...training.take(text.split(/(?<=\n)/).filter(Boolean)));

  return createInterpreterProcess(deps.post, (context) => {
    /** Pyodide up, the project copied in, writes tracked, stdio wired, `bfwc` and extensions installed, env and cwd set. */
    async function boot(message: StartMessage, staging: VirtualFileSystem): Promise<{ py: PyodideLike; provided: ProvidedPackages }> {
      const env = { ...message.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PWD: toPyodidePath(message.cwd) };
      const py = await deps.loadPyodide({ indexURL: message.python?.indexURL, env });
      const write = (stream: 'stdout' | 'stderr') => ({
        write: (buffer: Uint8Array) => {
          context.io[stream](buffer.slice());
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
      training.install(py, message.env);
      const provided = await installPythonExtensions(py, message.python?.extensions ?? [], deps.importModule ?? importModule);
      copyIntoPyodide(staging, py.FS);
      const tracker = trackPyodideWrites(py.FS, (ops) => {
        if (!context.exited) deps.post({ type: 'fs', ops });
      });
      context.mounted({ apply: (ops) => tracker.quietly(() => applyOpsToPyodide(py.FS, ops)), flush: () => tracker.flush() });
      const bootstrap = py.pyimport('bfwc.run').bootstrap as (env: unknown, cwd: string) => void;
      const pyEnv = py.toPy(env);
      try {
        bootstrap(pyEnv, toPyodidePath(message.cwd));
      } finally {
        pyEnv.destroy?.();
      }
      return { py, provided };
    }

    async function run(message: StartMessage, invocation: PythonInvocation, staging: VirtualFileSystem): Promise<InterpreterOutcome> {
      const { py, provided } = await boot(message, staging);
      if (context.exited) return { kind: 'exited', code: 0 }; // killed while Pyodide loaded
      const outcome = await runPythonInvocation(py, invocation, {
        cwd: toPyodidePath(message.cwd),
        env: message.env,
        io: { stdout: context.io.stdout, stderr: context.io.stderr, installed: (packages) => deps.post({ type: 'python-installed', ...packages }) },
        installs: message.python?.installs ?? [],
        provided,
      });
      // What the program wrote under the artifact directory is kept before its exit is reported.
      if (outcome.kind === 'exited') return training.persist().then(() => outcome);
      const server = outcome.server;
      return {
        kind: 'serving',
        server: { port: server.spec.port, handle: answering(server, context), close: () => server.close() },
        banner: `Serving ${server.spec.interface.toUpperCase()} app ${server.spec.app} on http://localhost:${server.spec.port} (request-driven)\n`,
      };
    }

    return {
      addressInUse,
      plan(message) {
        const parsed = parsePythonCommand(message.command, message.args, message.env);
        if (!parsed.ok) return { ok: false, message: `${message.command}: ${parsed.reason}\n`, code: 2 };
        const invocation = mapInvocationPaths(parsed.invocation, toPyodidePath);
        return { ok: true, port: invocation.kind === 'serve' ? invocation.server.port : undefined, run: (staging) => run(message, invocation, staging) };
      },
      stdin: (data) => pushStdin(data === null ? stdinDecoder.decode() : typeof data === 'string' ? data : stdinDecoder.decode(data, { stream: true })),
      receive: (message) => !!dialled?.receive(message),
    };
  });
}

/** A request to the served app; an interpreter that died fatally ends the process. */
function answering(server: PythonAppServer, context: InterpreterContext): PythonAppServer['handle'] {
  return (request) =>
    server.handle(request).catch((error: unknown) => {
      if (isFatal(error)) {
        context.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
        context.exit(1);
      }
      throw error;
    });
}
