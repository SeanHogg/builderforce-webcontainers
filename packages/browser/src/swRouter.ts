import { PREVIEW_ID, isWireResponse, previewPrefix, type WireResponse } from './protocol.js';

/** The part of MessagePort the router uses — a fake in tests, a real port in the worker. */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface PreviewTarget {
  id: string;
  path: string;
  search: string;
}

export interface RoutedResponse {
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

export interface SwRouterOptions {
  /** The worker registration's scope path (`/__bfwc/` or `/`). */
  scopePath: string;
  /** Ask open pages to re-attach `id` (the worker restarted and lost its ports). */
  requestReattach(id: string): Promise<void> | void;
  /** How long a page has to answer one request. */
  timeoutMs?: number;
  /** How long to wait for a page to re-attach before giving up. */
  reattachWaitMs?: number;
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

/**
 * Request routing for the preview service worker, with no worker globals in it.
 *
 * Browsers stop idle service workers at will, and a stopped worker forgets every
 * MessagePort it held. So a request for an unknown preview id is not a 404: the
 * router asks open pages to re-attach and waits briefly. A port that stops
 * answering (its tab closed) is dropped on timeout, so the NEXT request goes
 * through the re-attach path instead of timing out forever.
 */
export function createSwRouter(options: SwRouterOptions) {
  const prefix = previewPrefix(options.scopePath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const reattachWaitMs = options.reattachWaitMs ?? 3_000;
  const ports = new Map<string, PortLike>();
  const waiters = new Map<string, Array<(port: PortLike) => void>>();
  const pending = new Map<number, (response: WireResponse) => void>();
  let nextId = 0;

  function attach(id: string, port: PortLike): void {
    ports.set(id, port);
    port.onmessage = (event) => {
      if (!isWireResponse(event.data)) return;
      pending.get(event.data.reqId)?.(event.data);
      pending.delete(event.data.reqId);
    };
    for (const wake of waiters.get(id) ?? []) wake(port);
    waiters.delete(id);
  }

  function match(url: URL): PreviewTarget | null {
    if (!url.pathname.startsWith(prefix)) return null;
    const rest = url.pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const id = slash < 0 ? rest : rest.slice(0, slash);
    // Ids are `[A-Za-z0-9_-]`; a dotted segment is a real file beside the worker
    // (`sw.js`, `relay.html`), which must load from the network.
    if (!id || !PREVIEW_ID.test(id)) return null;
    return { id, path: slash < 0 ? '/' : rest.slice(slash), search: url.search };
  }

  async function portFor(id: string): Promise<PortLike | undefined> {
    const known = ports.get(id);
    if (known) return known;
    const arrived = new Promise<PortLike | undefined>((resolve) => {
      const list = waiters.get(id) ?? [];
      list.push(resolve);
      waiters.set(id, list);
      setTimeout(() => resolve(undefined), reattachWaitMs);
    });
    await options.requestReattach(id);
    return arrived;
  }

  async function respond(target: PreviewTarget): Promise<RoutedResponse> {
    const port = await portFor(target.id);
    if (!port) return { status: 503, headers: TEXT, body: 'This preview is not running in any open tab.' };
    const reqId = ++nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        if (ports.get(target.id) === port) ports.delete(target.id);
        resolve({ status: 504, headers: TEXT, body: 'The preview did not answer in time.' });
      }, timeoutMs);
      pending.set(reqId, (response) => {
        clearTimeout(timer);
        resolve({ status: response.status, headers: response.headers, body: response.body });
      });
      port.postMessage({ type: 'request', reqId, path: target.path, search: target.search });
    });
  }

  return { attach, match, respond, detach: (id: string) => ports.delete(id) };
}

export type SwRouter = ReturnType<typeof createSwRouter>;
