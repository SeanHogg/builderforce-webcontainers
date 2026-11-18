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
/** `undeliverable`: the error is a message that could not cross between the origins (`messageerror`). */
type FromWorker = { kind: 'message'; data: unknown } | { kind: 'error'; message: string; undeliverable?: true };

/** Told when a message to or from a process Worker could not be delivered (`messageerror`), with why. */
export type UndeliverableListener = (message: string) => void;

/** Why a process ended on a `messageerror`, for its stderr line. */
export function undeliverableMessage(direction: 'to' | 'from'): string {
  return `A message ${direction} the process Worker could not be delivered across origins (messageerror: e.g. a SharedArrayBuffer or an uncloneable value); the process was ended.`;
}

/**
 * Host side: a `WorkerLike` whose worker lives at the far end of `port`. A
 * message that cannot be delivered either way (`messageerror`) is never
 * swallowed: the Worker fails (`onerror`: the process exits non-zero with the
 * reason on stderr) and `onUndeliverable` hears it.
 */
export function workerOverPort(port: MessagePort, onUndeliverable?: UndeliverableListener): WorkerLike {
  let failed = false;
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
  const undeliverable = (message: string) => {
    if (failed) return;
    failed = true;
    try {
      onUndeliverable?.(message);
    } catch {
      // telemetry never changes the outcome
    }
    worker.onerror?.({ message });
    worker.terminate();
  };
  port.onmessage = (event: MessageEvent<FromWorker>) => {
    const message = event.data;
    if (message?.kind === 'message') worker.onmessage?.({ data: message.data });
    else if (message?.kind === 'error' && message.undeliverable) undeliverable(message.message);
    else if (message?.kind === 'error') worker.onerror?.({ message: message.message });
  };
  // The relay's reply itself could not be read here.
  port.onmessageerror = () => undeliverable(undeliverableMessage('from'));
  return worker;
}

/**
 * Relay side: run `worker`, relaying both ways over `port` until terminated. A
 * message that cannot be deserialized on either leg (`messageerror`: host →
 * relay on the port, Worker → relay) ends the Worker and tells the host as an
 * undeliverable error, so the process fails instead of hanging.
 */
export function bridgeWorker(port: MessagePort, worker: Worker): void {
  const fail = (direction: 'to' | 'from') => {
    port.postMessage({ kind: 'error', message: undeliverableMessage(direction), undeliverable: true } satisfies FromWorker);
    worker.terminate();
  };
  worker.onmessage = (event) => port.postMessage({ kind: 'message', data: event.data } satisfies FromWorker);
  worker.onerror = (event) => port.postMessage({ kind: 'error', message: event.message || 'The process worker failed.' } satisfies FromWorker);
  worker.onmessageerror = () => fail('from');
  port.onmessageerror = () => fail('to');
  port.onmessage = (event: MessageEvent<ToWorker>) => {
    const message = event.data;
    if (message?.kind === 'message') worker.postMessage(message.data);
    else if (message?.kind === 'terminate') {
      worker.terminate();
      port.close();
    }
  };
}

/**
 * Host side: ask the relay (through `post`) to start a Worker of `kind` on the
 * preview origin, under egress policy `policy` (an opaque signed id the embedder
 * minted; absent = the most restrictive policy); the Worker as a `WorkerLike`.
 * `onUndeliverable` hears a `messageerror` on either leg.
 */
export function spawnOverRelay(post: (message: unknown, transfer: Transferable[]) => void, kind: WorkerKind = 'node', policy?: string, onUndeliverable?: UndeliverableListener): WorkerLike {
  const channel = new MessageChannel();
  post({ type: RELAY_SPAWN, worker: kind, ...(policy === undefined ? {} : { policy }) }, [channel.port2]);
  return workerOverPort(channel.port1, onUndeliverable);
}

/** The process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_PROCESS_WORKER = 'process-worker.js';

/** The Python process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_PYTHON_WORKER = 'python-worker.js';

/** The PHP process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_PHP_WORKER = 'php-worker.js';

/** The .NET process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_DOTNET_WORKER = 'dotnet-worker.js';

/** The Rust process worker's file name beside `relay.html` on the preview origin. */
export const RELAY_RUST_WORKER = 'rust-worker.js';

/** The script the relay starts for each Worker kind. */
const RELAY_WORKER_SCRIPTS: Readonly<Record<WorkerKind, { file: string; name: string }>> = {
  node: { file: RELAY_PROCESS_WORKER, name: 'bfwc-process' },
  python: { file: RELAY_PYTHON_WORKER, name: 'bfwc-python' },
  php: { file: RELAY_PHP_WORKER, name: 'bfwc-php' },
  dotnet: { file: RELAY_DOTNET_WORKER, name: 'bfwc-dotnet' },
  rust: { file: RELAY_RUST_WORKER, name: 'bfwc-rust' },
};

/** The script the relay starts for a Worker kind (anything unknown is a Node process Worker). */
export function relayWorkerScript(kind: unknown): { file: string; name: string } {
  return typeof kind === 'string' && Object.hasOwn(RELAY_WORKER_SCRIPTS, kind) ? RELAY_WORKER_SCRIPTS[kind as WorkerKind] : RELAY_WORKER_SCRIPTS.node;
}

/** What an egress policy id may be: an opaque URL-safe token (a signed id, base64url or similar), at most 512 characters. */
export const WORKER_POLICY_ID = /^[A-Za-z0-9._~-]{1,512}$/;

/**
 * The URL the relay starts a Worker of `kind` from, beside `relayHref`, carrying
 * `?policy=<id>` (W10 control 6) so the server can serve the script with that
 * policy's CSP and caches vary by it. A missing or malformed id is left off: the
 * server then serves the most restrictive policy.
 */
export function relayWorkerUrl(kind: unknown, policy: unknown, relayHref: string): { url: URL; name: string } {
  const script = relayWorkerScript(kind);
  const url = new URL(`./${script.file}`, relayHref);
  // Verbatim (every allowed character is URL-safe), so the signature the server checks is the one it minted.
  if (typeof policy === 'string' && WORKER_POLICY_ID.test(policy)) url.search = `?policy=${policy}`;
  return { url, name: script.name };
}
