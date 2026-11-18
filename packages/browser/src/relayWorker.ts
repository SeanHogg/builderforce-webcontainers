/**
 * Process workers on the PREVIEW origin, driven from the host page.
 *
 * A process worker runs whatever the project runs — npm packages, the user's
 * server, an AI-written script. A worker started by the host page shares the
 * host's origin: its IndexedDB, Cache Storage and same-origin requests. In relay
 * mode that is exactly what the preview origin exists to keep apart, so the
 * relay frame starts each worker on ITS origin and this bridges the two over a
 * MessageChannel. The host side is a `WorkerLike`, so the process host cannot
 * tell the difference.
 */
import type { WorkerLike } from './node/processHost.js';
import type { WorkerKind } from './node/protocol.js';
import { RELAY_SPAWN } from './protocol.js';

type ToWorker = { kind: 'message'; data: unknown } | { kind: 'terminate' };
type FromWorker = { kind: 'message'; data: unknown } | { kind: 'error'; message: string };

/** Host side: a `WorkerLike` whose worker lives at the far end of `port`. */
export function workerOverPort(port: MessagePort): WorkerLike {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(data) {
      port.postMessage({ kind: 'message', data } satisfies ToWorker);
    },
    terminate() {
      port.postMessage({ kind: 'terminate' } satisfies ToWorker);
      port.close();
    },
  };
  port.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message?.kind === 'message') worker.onmessage?.({ data: message.data });
    else if (message?.kind === 'error') worker.onerror?.({ message: message.message });
  };
  return worker;
}

/** Relay side: run `worker`, relaying both ways over `port` until terminated. */
export function bridgeWorker(port: MessagePort, worker: Worker): void {
  worker.onmessage = (event) => port.postMessage({ kind: 'message', data: event.data } satisfies FromWorker);
  worker.onerror = (event) => port.postMessage({ kind: 'error', message: event.message || 'The process worker failed.' } satisfies FromWorker);
  port.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data;
    if (message?.kind === 'message') worker.postMessage(message.data);
    else if (message?.kind === 'terminate') {
      worker.terminate();
      port.close();
    }
  };
}

/** Host side: ask the relay (through `post`) to start a Worker of `kind` on the preview origin; the Worker as a `WorkerLike`. */
export function spawnOverRelay(post: (message: unknown, transfer: Transferable[]) => void, kind: WorkerKind = 'node'): WorkerLike {
  const channel = new MessageChannel();
  post({ type: RELAY_SPAWN, worker: kind }, [channel.port2]);
  return workerOverPort(channel.port1);
}

/** The process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_PROCESS_WORKER = 'process-worker.js';

/** The Python process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_PYTHON_WORKER = 'python-worker.js';

/** The script the relay starts for a Worker kind (anything unknown is a Node process Worker). */
export function relayWorkerScript(kind: unknown): { file: string; name: string } {
  return kind === 'python' ? { file: RELAY_PYTHON_WORKER, name: 'bfwc-python' } : { file: RELAY_PROCESS_WORKER, name: 'bfwc-process' };
}
