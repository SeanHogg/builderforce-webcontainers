/**
 * How the host page reaches the preview service worker.
 *
 * Same origin: the page registers the worker itself. The preview then runs on the
 * host's origin, with the host's storage and session — so the Security Shield
 * refuses it unless the embedder opts in by name (`unprotectedSameOrigin`, see
 * `previewOrigin.ts`).
 *
 * Relay: the worker lives on a SEPARATE preview origin. A hidden `relay.html` on
 * that origin registers it and passes ports and reloads across. The preview can
 * then never read the host's cookies, storage or DOM, which is what an editor
 * running AI-written code or arbitrary npm packages needs. With per-application
 * preview origins (`previewOrigins.ts`) each application gets its own relay.
 */
import {
  ATTACH,
  REATTACH,
  RELAY_ATTACH,
  RELAY_READY,
  RELAY_REATTACH,
  RELAY_UPDATE,
  type AttachProof,
} from './protocol.js';
import type { PreviewUpdate } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerLike } from './node/processHost.js';
import type { WorkerKind } from './node/protocol.js';
import { spawnOverRelay } from './relayWorker.js';
import { broadcastUpdate, waitForActive } from './worker.js';

export interface PreviewTransport {
  /** The origin previews are served from. */
  readonly origin: string;
  /** The worker's scope path on that origin. */
  readonly scope: string;
  /** Hand the worker the port that serves preview `id`, with this attach's nonce (see `AttachProof`) and its documents' declared egress. */
  attach(id: string, port: MessagePort, proof: AttachProof, egress?: readonly string[]): void;
  /** The worker restarted and wants `id` again. */
  onReattach(listener: (id: string) => void): () => void;
  /** Tell every frame showing the preview at `base` what changed: a hot update, or reload. */
  send(base: string, update: PreviewUpdate): void;
  /**
   * Start a process worker of `kind` (default `node`; `python` for Python
   * commands, `php` for PHP commands, `dotnet` for .NET commands) on the preview origin. Only the relay has one to offer;
   * same-origin mode runs processes on the host's origin, which is the trust it
   * already chose.
   */
  createWorker?(kind?: WorkerKind, policy?: string): WorkerLike;
  dispose(): void;
}

/** A relay whose frame may still be starting: what is sent to it waits until it has; `ready` settles when it starts or fails. */
export interface OpenedRelay extends PreviewTransport {
  readonly ready: Promise<void>;
}

/** How long the relay has to register its worker before boot gives up. */
const RELAY_TIMEOUT_MS = 15_000;

export async function sameOriginTransport(serviceWorkerUrl: string, scopeOption?: string): Promise<PreviewTransport> {
  const container = navigator.serviceWorker;
  if (!container) throw new Error('Service workers are unavailable here (a secure context — https or localhost — is required).');

  const scriptUrl = new URL(serviceWorkerUrl, location.href);
  const scope = new URL(scopeOption ?? './', scriptUrl).pathname;
  const registration = await container.register(scriptUrl.href, { scope });
  await waitForActive(registration);

  const listeners = new Set<(id: string) => void>();
  const onWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type === REATTACH && typeof event.data.id === 'string') for (const listener of listeners) listener(event.data.id);
  };
  container.addEventListener('message', onWorkerMessage);

  return {
    origin: location.origin,
    scope,
    attach: (id, port, proof, egress) => registration.active?.postMessage({ type: ATTACH, id, ...proof, egress }, [port]),
    onReattach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: broadcastUpdate,
    dispose() {
      container.removeEventListener('message', onWorkerMessage);
      listeners.clear();
    },
  };
}

/** Tell each port a message carried that the relay will never take it (a process Worker reports the error; an attach port just closes). */
function refusePorts(transfer: readonly Transferable[], message: string): void {
  for (const item of transfer) {
    const port = item as Partial<MessagePort>;
    if (typeof port.postMessage !== 'function') continue;
    port.postMessage({ kind: 'error', message });
    port.close?.();
  }
}

/**
 * Frame the relay at `relayUrl` now and return at once. Messages sent before it
 * is ready wait and go when it is; if it fails to start, every port they carried
 * is told so (a process Worker started early fails instead of hanging), and so
 * is every later one.
 */
export function openRelay(relayUrl: string): OpenedRelay {
  const url = new URL(relayUrl, location.href);
  const frame = document.createElement('iframe');
  frame.src = url.href;
  frame.title = 'Preview relay';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';

  const fromRelay = (event: MessageEvent) => event.origin === url.origin && event.source === frame.contentWindow;
  let state: 'starting' | 'ready' | 'failed' = 'starting';
  let failure = '';
  const queued: Array<{ message: unknown; transfer: Transferable[] }> = [];

  const deliver = (message: unknown, transfer: Transferable[]) => frame.contentWindow?.postMessage(message, url.origin, transfer);
  const post = (message: unknown, transfer: Transferable[] = []) => {
    if (state === 'ready') deliver(message, transfer);
    else if (state === 'starting') queued.push({ message, transfer });
    else refusePorts(transfer, failure);
  };

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => settle(`The preview relay at ${url.origin} did not start.`), RELAY_TIMEOUT_MS);
    function settle(error?: string) {
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      const waiting = queued.splice(0);
      if (error === undefined) {
        state = 'ready';
        for (const { message, transfer } of waiting) deliver(message, transfer);
        return resolve();
      }
      state = 'failed';
      failure = error;
      frame.remove();
      for (const { transfer } of waiting) refusePorts(transfer, error);
      reject(new Error(error));
    }
    function onReady(event: MessageEvent) {
      if (!fromRelay(event) || event.data?.type !== RELAY_READY) return;
      settle(typeof event.data.error === 'string' ? event.data.error : undefined);
    }
    window.addEventListener('message', onReady);
  });
  ready.catch(() => undefined); // a relay opened on demand may never be awaited; its failure reaches the ports instead
  document.body.appendChild(frame);

  const listeners = new Set<(id: string) => void>();
  const onRelayMessage = (event: MessageEvent) => {
    if (!fromRelay(event) || event.data?.type !== RELAY_REATTACH || typeof event.data.id !== 'string') return;
    for (const listener of listeners) listener(event.data.id);
  };
  window.addEventListener('message', onRelayMessage);

  return {
    origin: url.origin,
    scope: new URL('./', url).pathname,
    ready,
    attach: (id, port, proof, egress) => post({ type: RELAY_ATTACH, id, ...proof, egress }, [port]),
    onReattach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send: (base, update) => post({ type: RELAY_UPDATE, base, update }),
    createWorker: (kind: WorkerKind = 'node', policy?: string) => spawnOverRelay(post, kind, policy),
    dispose() {
      window.removeEventListener('message', onRelayMessage);
      listeners.clear();
      queued.length = 0;
      frame.remove();
    },
  };
}

/** Frame the relay at `relayUrl` and wait until its worker is active; rejects (and removes the frame) when it cannot start. */
export async function relayTransport(relayUrl: string): Promise<PreviewTransport> {
  const relay = openRelay(relayUrl);
  try {
    await relay.ready;
  } catch (error) {
    relay.dispose();
    throw error;
  }
  return relay;
}
