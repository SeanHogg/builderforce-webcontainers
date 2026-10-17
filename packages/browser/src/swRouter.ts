import { PREVIEW_ID, isPortPath, isWireReply, previewPrefix, type WireCancel, type WireResponse } from './protocol.js';

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

/** The parts of a request a virtual server needs (method, headers, body). */
export interface RequestDetails {
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

export interface RoutedResponse {
  status: number;
  headers: Record<string, string>;
  /** A stream when the page streams the body (a virtual server's response): chunks arrive as the server writes them. */
  body: string | ArrayBuffer | ReadableStream<Uint8Array> | null;
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
 *
 * A virtual server's response streams: the page sends the head (`streaming`),
 * then `chunk` messages and an `end`, and the router answers the fetch with a
 * ReadableStream fed by them. The timeout covers only the wait for the head (an
 * event stream may stay open indefinitely); cancelling the stream (the preview
 * closed its EventSource) tells the page to hang up on the server.
 */
export function createSwRouter(options: SwRouterOptions) {
  const prefix = previewPrefix(options.scopePath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const reattachWaitMs = options.reattachWaitMs ?? 3_000;
  const ports = new Map<string, PortLike>();
  const waiters = new Map<string, Array<(port: PortLike) => void>>();
  const pending = new Map<number, (response: WireResponse) => void>();
  const streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();
  let nextId = 0;

  function attach(id: string, port: PortLike): void {
    ports.set(id, port);
    port.onmessage = (event) => {
      const reply = event.data;
      if (!isWireReply(reply)) return;
      if (reply.type === 'response') {
        pending.get(reply.reqId)?.(reply);
        pending.delete(reply.reqId);
        return;
      }
      const controller = streams.get(reply.reqId);
      if (!controller) return;
      try {
        if (reply.type === 'chunk') return controller.enqueue(new Uint8Array(reply.data));
        streams.delete(reply.reqId);
        if (reply.error) controller.error(new Error(reply.error));
        else controller.close();
      } catch {
        streams.delete(reply.reqId); // the reader already went away
      }
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

  /**
   * Pages served by a virtual server (`/__bfwc/<id>/__port/3000/`) write absolute
   * URLs (`/style.css`, `fetch('/api')`). A service worker sees every request its
   * clients make, so a same-origin request from such a page that falls outside
   * the preview prefix is mapped back under that server's path.
   */
  const clientServers = new Map<string, { id: string; prefix: string }>();

  function rememberClient(clientId: string | undefined, target: PreviewTarget): void {
    if (!clientId || !isPortPath(target.path)) return;
    const prefix = /^\/__port\/\d+/.exec(target.path)![0];
    clientServers.set(clientId, { id: target.id, prefix });
    if (clientServers.size > 200) clientServers.delete(clientServers.keys().next().value!);
  }

  function matchForClient(url: URL, clientId: string | undefined, origin: string): PreviewTarget | null {
    const direct = match(url);
    if (direct || !clientId || url.origin !== origin) return direct;
    const server = clientServers.get(clientId);
    return server ? { id: server.id, path: server.prefix + url.pathname, search: url.search } : null;
  }

  async function respond(target: PreviewTarget, details?: RequestDetails): Promise<RoutedResponse> {
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
        if (!response.streaming) return resolve({ status: response.status, headers: response.headers, body: response.body });
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => void streams.set(reqId, controller),
          cancel: () => {
            if (streams.delete(reqId)) port.postMessage({ type: 'cancel', reqId } satisfies WireCancel);
          },
        });
        resolve({ status: response.status, headers: response.headers, body });
      });
      port.postMessage({ type: 'request', reqId, path: target.path, search: target.search, ...details });
    });
  }

  return { attach, match, matchForClient, rememberClient, respond, detach: (id: string) => ports.delete(id) };
}

export type SwRouter = ReturnType<typeof createSwRouter>;
