/**
 * The worker side of one PHP process: the shared interpreter-process skeleton
 * (runtimes/interpreterProcess.ts — the process protocol, the staged project,
 * served ports, exit and kill) with php-wasm as the interpreter. `php -S`
 * answers each `http-request` through php-wasm's request runner
 * (phpWebServer.ts); PHP's sockets dial the runtime's virtual ports (`dial`
 * messages, phpSockets.ts). Once read, the running PHP's version and
 * extensions are reported with `php-platform` (the page's `php` provider
 * checks services against them). Standard input is not forwarded: PHP reads
 * end of file.
 *
 * The start message's `php` field carries the host's instructions — where
 * php-wasm is served, the PHP version, Composer's sources — never the
 * environment.
 *
 * No worker globals in here — `post` and the PHP loader are injected — so the
 * same code runs in a real Worker (worker.ts) and in-thread in tests.
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, StartMessage, WorkerToHost } from '../../node/protocol.js';
import { createWorkerDialer } from '../../node/workerConnections.js';
import { createInterpreterProcess, type InterpreterContext, type InterpreterOutcome } from '../interpreterProcess.js';
import { mapInvocationPaths, parsePhpCommand, type PhpInvocation } from './phpCommand.js';
import { trackWrappedFsWrites } from '../emscripten/wrappedFsWrites.js';
import { applyOpsToPhp, copyIntoPhp, toPhpPath } from './phpFs.js';
import { checkPhpVersion, type LoadedPhp, type PhpLoadOptions } from './phpLoader.js';
import { runPhpInvocation } from './phpProgram.js';
import { installRuntimeLibrary } from './phpRuntimeLibrary.js';
import { installPhpSockets, type Dial } from './phpSockets.js';

export interface PhpWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** A fresh PHP (`loadPhpRuntime` in a Worker; `@php-wasm/node` in tests). */
  loadPhp(options: PhpLoadOptions): Promise<LoadedPhp>;
  /** Virtual TCP for PHP's sockets. Default: the process protocol's dialled connections. */
  dial?: Dial;
  /** Composer's network (metadata and dists). Default: `fetch`. */
  fetch?: typeof fetch;
}

const addressInUse = (host: string, port: number) => `[${new Date().toUTCString()}] Failed to listen on ${host}:${port} (reason: Address already in use)\n`;

export function createPhpWorkerProcess(deps: PhpWorkerProcessDeps): { receive(message: HostToWorker): void } {
  const dialer = deps.dial ? undefined : createWorkerDialer(deps.post);
  const dial: Dial = deps.dial ?? ((port) => dialer!.dial(port));
  let host = 'localhost';

  return createInterpreterProcess(deps.post, (context) => {
    /** PHP up, sockets on virtual TCP, the runtime library in, the project copied in and tracked. */
    async function boot(message: StartMessage, staging: VirtualFileSystem): Promise<LoadedPhp> {
      const php = await deps.loadPhp({ baseUrl: message.php?.baseUrl, phpVersion: checkPhpVersion(message.php?.phpVersion) });
      installPhpSockets(php.module, dial);
      installRuntimeLibrary(php.module.FS);
      copyIntoPhp(staging, php.module.FS);
      const tracker = trackWrappedFsWrites(php.module.FS, (ops) => {
        if (!context.exited) deps.post({ type: 'fs', ops });
      });
      context.mounted({ apply: (ops) => tracker.quietly(() => applyOpsToPhp(php.module.FS, ops)), flush: () => tracker.flush() });
      php.php.chdir(toPhpPath(message.cwd));
      return php;
    }

    async function run(message: StartMessage, invocation: PhpInvocation, staging: VirtualFileSystem, ctx: InterpreterContext): Promise<InterpreterOutcome> {
      const php = await boot(message, staging);
      if (ctx.exited) return { kind: 'exited', code: 0 }; // killed while PHP loaded
      return runPhpInvocation(php, invocation, {
        cwd: toPhpPath(message.cwd),
        env: message.env,
        io: ctx.io,
        composer: message.php?.composer,
        fetch: deps.fetch,
        platformKnown: (platform) => deps.post({ type: 'php-platform', phpVersion: platform.phpVersion, extensions: [...platform.extensions] }),
      });
    }

    return {
      addressInUse: (port) => addressInUse(host, port),
      plan(message) {
        const parsed = parsePhpCommand(message.command, message.args);
        if (!parsed.ok) return { ok: false, message: `${message.command}: ${parsed.reason}\n`, code: 1 };
        try {
          checkPhpVersion(message.php?.phpVersion);
        } catch (error) {
          return { ok: false, message: `${(error as Error).message}\n`, code: 1 };
        }
        const invocation = mapInvocationPaths(parsed.invocation, toPhpPath);
        if (invocation.kind === 'serve') host = invocation.server.host;
        return { ok: true, port: invocation.kind === 'serve' ? invocation.server.port : undefined, run: (staging) => run(message, invocation, staging, context) };
      },
      receive: (message) => !!dialer?.receive(message),
    };
  });
}
