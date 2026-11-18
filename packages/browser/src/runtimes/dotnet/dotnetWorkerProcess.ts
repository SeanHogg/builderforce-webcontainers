/**
 * The worker side of one .NET process. It speaks the process Workers' protocol
 * (node/protocol.ts), so the page's process host drives it like any other
 * process: `prime`/`start` mount the project from the shared snapshot pack,
 * `fs` ops flow both ways (the Emscripten mirror, writes heard as php-wasm's
 * are), stdout and stderr stream, `exit` carries the code, `kill` stops the
 * program's host and ends it. An ASP.NET Core app's in-memory server announces
 * its ports with `listen` and answers each `http-request` (dotnetInterop.ts,
 * via node/servedPorts.ts); a `listen-failed` ends it. Npgsql and other
 * outbound TCP dial the runtime's virtual ports (`dial` messages).
 *
 * The runtime (Mono, the host program, Roslyn, ASP.NET Core, Npgsql) is
 * fetched from the host's bundle URL — the start message's `dotnet` field,
 * never the environment — and only once the command needs it: a project the
 * runtime cannot build is refused first.
 *
 * No worker globals in here — `post` and the loader are injected — so the
 * same code runs in a real Worker (worker.ts) and in-thread in tests.
 */
import { VirtualFileSystem, applyOps, mountSnapshot, signalExitCode, type VfsOp } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, StartMessage, WorkerToHost } from '../../node/protocol.js';
import { createServedPorts } from '../../node/servedPorts.js';
import { createWorkerDialer } from '../../node/workerConnections.js';
import { applyOpsToMount, copyIntoMount, toMountPath, type MountWriteTracker } from '../emscripten/projectMirror.js';
import { trackPhpWrites } from '../php/phpFs.js';
import { parseDotnetCommand } from './dotnetCommand.js';
import { createDotnetBridge, type Dial } from './dotnetInterop.js';
import { readManifest, type DotnetLoadOptions, type LoadedDotnet } from './dotnetLoader.js';
import { prepareInvocation, runWithRuntime } from './dotnetProgram.js';
import { dotnetStartOptionsOf } from './dotnetStartOptions.js';

export interface DotnetWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** A started runtime (`loadDotnetRuntime` in a Worker and in the bundle-backed tests; a fake in unit tests). */
  loadDotnet(options: DotnetLoadOptions): Promise<LoadedDotnet>;
  /** Virtual TCP. Default: the process protocol's dialled connections. */
  dial?: Dial;
  /** For the bundle's manifest. Default `fetch`. */
  fetch?: typeof fetch;
}

const NO_BUNDLE = 'The .NET runtime bundle is not configured: the host must pass `dotnet.bundleUrl` (build it with scripts/build-dotnet-runtime.mjs).';

export function createDotnetWorkerProcess(deps: DotnetWorkerProcessDeps): { receive(message: HostToWorker): void } {
  /** The project until the runtime holds it: the snapshot mounts here, early ops land here. */
  let staging: VirtualFileSystem | undefined = new VirtualFileSystem();
  let loaded: LoadedDotnet | undefined;
  let tracker: MountWriteTracker | undefined;
  let exited = false;
  const dialer = deps.dial ? undefined : createWorkerDialer(deps.post);
  const dial: Dial = deps.dial ?? ((port) => dialer!.dial(port));

  const io = {
    stdout: (data: string) => !exited && deps.post({ type: 'stdout', data }),
    stderr: (data: string) => !exited && deps.post({ type: 'stderr', data }),
  };
  let bridge: ReturnType<typeof createDotnetBridge>;
  const served = createServedPorts({
    post: deps.post,
    handlerFor: (port) => bridge.handlerFor(port),
    onListenFailed(port) {
      if (!bridge.listening.has(port)) return;
      io.stderr(`Unhandled exception. System.IO.IOException: Failed to bind to address http://localhost:${port}: address already in use.\n`);
      stop('SIGTERM', 1);
    },
  });
  bridge = createDotnetBridge({ post: deps.post, dial, taken: served.taken, stdout: (text) => io.stdout(text), stderr: (text) => io.stderr(text) });

  const applyIncoming = (ops: readonly VfsOp[]) => {
    if (staging) return applyOps(staging, ops);
    if (loaded && tracker) tracker.quietly(() => applyOpsToMount(loaded!.FS, ops));
  };

  function exit(code: number): void {
    if (exited) return;
    try {
      loaded?.exports.Flush();
    } catch {
      // A runtime that died cannot flush.
    }
    tracker?.flush(); // every write reaches the page before the exit does
    exited = true;
    for (const port of bridge.listening) deps.post({ type: 'unlisten', port });
    bridge.closeAll();
    deps.post({ type: 'exit', code });
  }

  function stop(signal: string, code = signalExitCode(signal)): void {
    served.cancelAll();
    try {
      loaded?.exports.Stop();
    } catch {
      // Stopping is best effort: the Worker is terminated after the exit.
    }
    exit(code);
  }

  async function boot(message: StartMessage, bundleUrl: string, env: Record<string, string>): Promise<LoadedDotnet> {
    const runtime = await deps.loadDotnet({ bundleUrl, env, imports: bridge.imports, onExit: (code) => exit(code), fetch: deps.fetch });
    copyIntoMount(staging!, runtime.FS);
    staging = undefined; // from here on, page ops go straight into the runtime
    loaded = runtime;
    tracker = trackPhpWrites(runtime.FS, (ops) => {
      if (!exited) deps.post({ type: 'fs', ops });
    });
    runtime.exports.Init();
    bridge.attach(runtime.exports);
    runtime.FS.mkdirTree(toMountPath(message.cwd));
    return runtime;
  }

  async function start(message: StartMessage): Promise<void> {
    const { snapshot } = message;
    if (snapshot.pack) mountSnapshot(staging!, snapshot);
    else applyIncoming(snapshot.ops);
    for (const port of message.ports) served.taken.add(port);
    const parsed = parseDotnetCommand(message.command, message.args);
    if (!parsed.ok) {
      io.stderr(`${parsed.reason}\n`);
      return exit(1);
    }
    const bundleUrl = dotnetStartOptionsOf(message)?.bundleUrl;
    const prepared = await prepareInvocation(parsed.invocation, {
      files: staging!,
      cwd: message.cwd,
      env: message.env,
      io,
      sendOps: (ops) => deps.post({ type: 'fs', ops }),
      manifest: () => (bundleUrl ? readManifest(bundleUrl, deps.fetch) : Promise.reject(new Error(NO_BUNDLE))),
    });
    if (prepared.kind === 'done') return exit(prepared.code);
    if (!bundleUrl) {
      io.stderr(`${NO_BUNDLE}\n`);
      return exit(1);
    }
    const runtime = await boot(message, bundleUrl, prepared.work.env);
    if (exited) return; // killed while the runtime loaded
    const code = await runWithRuntime(prepared.work, runtime, io);
    exit(code);
  }

  return {
    receive(message) {
      if (served.receive(message) || dialer?.receive(message)) return;
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
          return stop(message.signal);
        case 'socket-open':
        case 'socket-accept':
          // The in-memory server answers HTTP requests only: refuse WebSocket upgrades and raw TCP.
          return deps.post({ type: 'socket-close', connId: message.connId });
        default:
          // stdin, children, IPC, loopback responses: a .NET process uses none of them.
          return;
      }
    },
  };
}
