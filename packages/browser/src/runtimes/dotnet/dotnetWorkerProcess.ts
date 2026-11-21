/**
 * The worker side of one .NET process, on the interpreter processes' skeleton
 * (runtimes/interpreterProcess.ts: `prime`/`start` staging, `fs` ops both
 * ways, stdout/stderr until the exit, `kill`, refused WebSocket and raw-TCP
 * connections, every write flushed before the exit). What is .NET's is here:
 * the command line, the build plan made before anything loads, Mono started
 * from the host's bundle (the start message's `dotnet` field, never the
 * environment), the mirror heard by wrapping Mono's FS calls, and an ASP.NET
 * Core host claiming its own ports (the bridge, dotnetInterop.ts: a
 * {@link DynamicPorts} outcome). Npgsql and other outbound TCP dial the
 * runtime's virtual ports (`dial` messages).
 *
 * A bundle that is absent, unreachable or fails its integrity check ends the
 * process with one line saying so (exit 1), never a stack.
 *
 * No worker globals in here — `post` and the loader are injected — so the
 * same code runs in a real Worker (worker.ts) and in-thread in tests.
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from '../../node/protocol.js';
import { createWorkerDialer } from '../../node/workerConnections.js';
import { applyOpsToMount, copyIntoMount, toMountPath } from '../emscripten/projectMirror.js';
import { trackWrappedFsWrites } from '../emscripten/wrappedFsWrites.js';
import { createInterpreterProcess, type InterpreterOutcome } from '../interpreterProcess.js';
import { parseDotnetCommand } from './dotnetCommand.js';
import { createDotnetBridge, type Dial } from './dotnetInterop.js';
import { DotnetBundleError, readManifest, type DotnetLoadOptions, type LoadedDotnet } from './dotnetLoader.js';
import { prepareInvocation, runWithRuntime } from './dotnetProgram.js';
import { DOTNET_BUNDLE_SOURCE } from './dotnetBundle.js';

export interface DotnetWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** A started runtime (`loadDotnetRuntime` in a Worker and in the bundle-backed tests; a fake in unit tests). */
  loadDotnet(options: DotnetLoadOptions): Promise<LoadedDotnet>;
  /** Virtual TCP. Default: the process protocol's dialled connections. */
  dial?: Dial;
  /** For the bundle's manifest. Default `fetch`. */
  fetch?: typeof fetch;
}

const NO_BUNDLE = `The .NET runtime bundle is not configured: the host must pass \`dotnet.bundleUrl\` (to get the bundle, ${DOTNET_BUNDLE_SOURCE}).`;

/** What a real `dotnet` prints when a server's port is taken (Kestrel's unhandled IOException). */
const addressInUse = (port: number) => `Unhandled exception. System.IO.IOException: Failed to bind to address http://localhost:${port}: address already in use.\n`;

export function createDotnetWorkerProcess(deps: DotnetWorkerProcessDeps): { receive(message: HostToWorker): void } {
  const dialer = deps.dial ? undefined : createWorkerDialer(deps.post);
  const dial: Dial = deps.dial ?? ((port) => dialer!.dial(port));

  return createInterpreterProcess(deps.post, (context) => {
    const io = { stdout: (text: string) => context.io.stdout(text), stderr: (text: string) => context.io.stderr(text) };
    const bridge = createDotnetBridge({ post: deps.post, dial, taken: context.takenPorts, ...io });

    /** Mono up from the bundle, the project copied in and tracked, the host program initialised. */
    async function boot(bundleUrl: string, env: Record<string, string>, cwd: string, staging: VirtualFileSystem): Promise<LoadedDotnet> {
      const runtime = await deps.loadDotnet({ bundleUrl, env, imports: bridge.imports, onExit: (code) => context.exit(code), fetch: deps.fetch });
      copyIntoMount(staging, runtime.FS);
      const tracker = trackWrappedFsWrites(runtime.FS, (ops) => {
        if (!context.exited) deps.post({ type: 'fs', ops });
      });
      context.mounted({
        apply: (ops) => tracker.quietly(() => applyOpsToMount(runtime.FS, ops)),
        flush() {
          try {
            runtime.exports.Flush();
          } catch {
            // A runtime that died cannot flush.
          }
          tracker.flush();
        },
      });
      runtime.exports.Init();
      bridge.attach(runtime.exports);
      runtime.FS.mkdirTree(toMountPath(cwd));
      return runtime;
    }

    /** A bundle failure as one line and exit 1; anything else is the skeleton's to report. */
    const bundleFailure = (error: unknown): number => {
      if (!(error instanceof DotnetBundleError)) throw error;
      io.stderr(`${error.message}\n`);
      return 1;
    };

    return {
      addressInUse,
      receive: (message) => !!dialer?.receive(message),
      plan(message) {
        const parsed = parseDotnetCommand(message.command, message.args);
        if (!parsed.ok) return { ok: false, message: `${parsed.reason}\n`, code: 1 };
        const bundleUrl = message.dotnet?.bundleUrl;
        return {
          ok: true,
          async run(staging): Promise<InterpreterOutcome> {
            try {
              const prepared = await prepareInvocation(parsed.invocation, {
                files: staging,
                cwd: message.cwd,
                env: message.env,
                io,
                sendOps: (ops) => deps.post({ type: 'fs', ops }),
                manifest: () => (bundleUrl ? readManifest(bundleUrl, deps.fetch) : Promise.reject(new DotnetBundleError(NO_BUNDLE))),
              });
              if (prepared.kind === 'done') return { kind: 'exited', code: prepared.code };
              if (!bundleUrl) throw new DotnetBundleError(NO_BUNDLE);
              const runtime = await boot(bundleUrl, prepared.work.env, message.cwd, staging);
              if (context.exited) return { kind: 'exited', code: 1 }; // killed while the runtime loaded
              // A reference pack the build needs is fetched (and checked) only now: its failure is one line too.
              return { kind: 'running', ports: bridge, done: runWithRuntime(prepared.work, runtime, io).catch(bundleFailure) };
            } catch (error) {
              return { kind: 'exited', code: bundleFailure(error) };
            }
          },
        };
      },
    };
  });
}
