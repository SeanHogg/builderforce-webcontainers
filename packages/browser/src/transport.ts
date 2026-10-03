/**
 * How the host page reaches the preview service worker.
 *
 * Same origin: the page registers the worker itself. Simple, but the preview then
 * runs on the host's origin, with the host's storage and session — fine for a
 * page that only previews code its own user wrote and trusts.
 *
 * Relay: the worker lives on a SEPARATE preview origin. A hidden `relay.html` on
 * that origin registers it and passes ports and reloads across. The preview can
 * then never read the host's cookies, storage or DOM, which is what an editor
 * running AI-written code or arbitrary npm packages needs.
 */
import {
  ATTACH,
  REATTACH,
  RELAY_ATTACH,
  RELAY_READY,
  RELAY_REATTACH,
  RELAY_RELOAD,
  RELAY_SPAWN,
} from './protocol.js';
import type { WorkerLike } from './node/processHost.js';
import { workerOverPort } from './relayWorker.js';
import { broadcastReload, waitForActive } from './worker.js';

export interface PreviewTransport {
  /** The origin previews are served from. */
  readonly origin: string;
  /** The worker's scope path on that origin. */
  readonly scope: string;
  /** Hand the worker the port that serves preview `id`. */
  attach(id: string, port: MessagePort): void;
  /** The worker restarted and wants `id` again. */
  onReattach(listener: (id: string) => void): () => void;
  /** Reload every frame showing the preview at `base`. */
  reload(base: string): void;
  /**
   * Start a process worker on the preview origin. Only the relay has one to
   * offer; same-origin mode runs processes on the host's origin, which is the
   * trust it already chose.
   */
  createWorker?(): WorkerLike;
  dispose(): void;
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
    attach: (id, port) => registration.active?.postMessage({ type: ATTACH, id }, [port]),
    onReattach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: broadcastReload,
    dispose() {
      container.removeEventListener('message', onWorkerMessage);
      listeners.clear();
    },
  };
}

export async function relayTransport(relayUrl: string): Promise<PreviewTransport> {
  const url = new URL(relayUrl, location.href);
  const frame = document.createElement('iframe');
  frame.src = url.href;
  frame.title = 'Preview relay';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';

  const fromRelay = (event: MessageEvent) => event.origin === url.origin && event.source === frame.contentWindow;

  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onReady);
      reject(new Error(`The preview relay at ${url.origin} did not start.`));
    }, RELAY_TIMEOUT_MS);
    function onReady(event: MessageEvent) {
      if (!fromRelay(event) || event.data?.type !== RELAY_READY) return;
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      if (typeof event.data.error === 'string') reject(new Error(event.data.error));
      else resolve();
    }
    window.addEventListener('message', onReady);
  });
  document.body.appendChild(frame);
  try {
    await ready;
  } catch (error) {
    frame.remove();
    throw error;
  }

  const listeners = new Set<(id: string) => void>();
  const onRelayMessage = (event: MessageEvent) => {
    if (!fromRelay(event) || event.data?.type !== RELAY_REATTACH || typeof event.data.id !== 'string') return;
    for (const listener of listeners) listener(event.data.id);
  };
  window.addEventListener('message', onRelayMessage);
  const post = (message: unknown, transfer: Transferable[] = []) => frame.contentWindow?.postMessage(message, url.origin, transfer);

  return {
    origin: url.origin,
    scope: new URL('./', url).pathname,
    attach: (id, port) => post({ type: RELAY_ATTACH, id }, [port]),
    onReattach(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: (base) => post({ type: RELAY_RELOAD, base }),
    createWorker() {
      const channel = new MessageChannel();
      post({ type: RELAY_SPAWN }, [channel.port2]);
      return workerOverPort(channel.port1);
    },
    dispose() {
      window.removeEventListener('message', onRelayMessage);
      listeners.clear();
      frame.remove();
    },
  };
}
