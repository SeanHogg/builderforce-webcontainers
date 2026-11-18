/**
 * The worker side of one Rust process: the shared interpreter-process skeleton
 * (runtimes/interpreterProcess.ts — the process protocol, the staged project,
 * served ports, exit and kill) with a prebuilt wasm32-wasip1 module on the
 * WASI host as the program (rustProgram.ts). The staged project stays the
 * module's file system, mirrored like a Node process's (node/vfsForwarding.ts):
 * what the module writes is posted to the page as `fs` ops, and the page's ops
 * land in it without echoing back. A service's outbound TCP (tokio-postgres to
 * the Postgres gateway) dials the runtime's virtual ports through the one dial
 * choke point (rustDial.ts). Standard input is not forwarded: the module reads
 * end of file.
 *
 * No worker globals in here — `post` is injected — so the same code runs in a
 * real Worker (worker.ts) and in-thread in tests.
 */
import type { HostToWorker, WorkerToHost } from '../../node/protocol.js';
import { forwardVfsChanges } from '../../node/vfsForwarding.js';
import { createWorkerDialer } from '../../node/workerConnections.js';
import { createInterpreterProcess } from '../interpreterProcess.js';
import type { Dial } from './rustBridge.js';
import { parseRustCommand } from './rustCommand.js';
import { createRustDial } from './rustDial.js';
import { runRustModule } from './rustProgram.js';

export interface RustWorkerProcessDeps {
  post(message: WorkerToHost): void;
  /** Virtual TCP. Default: the process protocol's dialled connections. */
  dial?: Dial;
}

const addressInUse = (port: number) => `Error: Address already in use (os error 98): 0.0.0.0:${port}\n`;

export function createRustWorkerProcess(deps: RustWorkerProcessDeps): { receive(message: HostToWorker): void } {
  const dialer = deps.dial ? undefined : createWorkerDialer(deps.post);
  const dial = createRustDial(deps.dial ?? ((port) => dialer!.dial(port)));

  return createInterpreterProcess(deps.post, (context) => ({
    addressInUse,
    plan(message) {
      const parsed = parseRustCommand(message.command, message.args);
      if (!parsed.ok) return { ok: false, message: `error: ${parsed.reason}\n`, code: 1 };
      return {
        ok: true,
        run: async (staging) => {
          const mirror = forwardVfsChanges(staging, (ops) => {
            if (!context.exited) context.post({ type: 'fs', ops });
          });
          context.mounted({ apply: mirror.apply, flush: mirror.flush });
          return runRustModule(parsed.invocation, {
            fs: staging,
            cwd: message.cwd,
            env: message.env,
            io: context.io,
            dial,
            ended: (code) => context.exit(code),
          });
        },
      };
    },
    receive: (message) => !!dialer?.receive(message),
  }));
}
