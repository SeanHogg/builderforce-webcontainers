import { PREVIEW_ID, attachProofOf, isPortPath, isWireReply, previewPrefix, type AttachProof, type WireAttached, type WireCancel, type WireResponse } from './protocol.js';
import type { AttachClient, AttachMode, IngressRejection } from './swBindings.js';
import { createIngressGuard } from './swGuard.js';

export type { LookupRequest } from './swGuard.js';
import { DEFAULT_MAX_BODY_BYTES, readBoundedBody, type BodySource } from './swBody.js';

export { attachModeOf, type AttachClient, type AttachMode, type AttachRefusal, type IngressRejection } from './swBindings.js';
export { DEFAULT_MAX_BODY_BYTES, readBoundedBody, type BodySource } from './swBody.js';

/** The part of MessagePort the router uses — a fake in tests, a real port in the worker. */
export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  /** Closed when the worker refuses the port. */
  close?(): void;
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
  /** The largest request body a virtual server is handed (default 32 MiB); larger is 413. */
  maxBodyBytes?: number;
  /** Who registered the worker (`attachModeOf(scriptUrl)`); default `same-origin`. */
  attachMode?: AttachMode;
  /** `clients.get(id)`. Without it every unbound client is refused and a live attach binding never moves. */
  getClient?(clientId: string): Promise<AttachClient | undefined>;
  /** Told about every refused attach or request. Its failures are ignored. */
  onReject?(rejection: IngressRejection): void;
  /** The clock for cached client verdicts (tests). */
  now?(): number;
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
 *
 * Routing integrity (W10 control 2) is decided by the guard (`swGuard`):
 * `acceptAttach`, `admit` and the client lookup; `readBody` caps request bodies.
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
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const guard = createIngressGuard({
    ...options,
    previewIdOf: (url) => match(url)?.id ?? null,
    // A virtual-server page the worker forgot (restart) gets its absolute-URL remap back.
    onIdentified: (clientId, url) => {
      const target = match(url);
      if (target) rememberClient(clientId, target);
    },
    hasRemap: (clientId) => clientServers.has(clientId),
  });

  /** Drop `port` for `id`: forget it, stop listening and close it. Every removal goes through here. */
  function releasePort(id: string, port: PortLike): void {
    if (ports.get(id) === port) ports.delete(id);
    port.onmessage = null;
    port.close?.();
  }

  /** Install a port `acceptAttach` has admitted (acknowledging `nonce` on it), releasing the one it replaces. */
  function attach(id: string, port: PortLike, nonce: string): void {
    const previous = ports.get(id);
    if (previous && previous !== port) releasePort(id, previous);
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
    // The page advances its nonce chain only on this, so a dropped attach never desyncs it.
    port.postMessage({ type: 'attached', nonce } satisfies WireAttached);
    for (const wake of waiters.get(id) ?? []) wake(port);
    waiters.delete(id);
  }

  /**
   * An attach from `client` (`event.source`) carrying `proof` (`attachProofOf`),
   * decided by the guard (nonce, attacher, binding, unique id per tab). A refused
   * port is closed (a stale nonce from the bound client also asks it for a fresh
   * attach). An attach carries no egress: that is the worker's own configuration.
   */
  async function acceptAttach(id: string, port: PortLike, client: AttachClient | null | undefined, proof: AttachProof | null | undefined): Promise<boolean> {
    if (await guard.checkAttach(id, client, proof)) {
      attach(id, port, attachProofOf(proof)!.nonce);
      return true;
    }
    port.close?.();
    return false;
  }

  /** Check a routed request against the client bindings (see the guard): 403, or `null` = go ahead. */
  async function admit(target: PreviewTarget, clientId: string | undefined, resultingClientId: string | undefined): Promise<RoutedResponse | null> {
    if (await guard.checkClient(target.id, clientId || undefined, resultingClientId || undefined)) return null;
    return { status: 403, headers: TEXT, body: 'This page may not reach that preview.' };
  }

  /** A virtual server's request body, or a 413 when it is over `maxBodyBytes`. */
  async function readBody(target: PreviewTarget, source: BodySource, clientId?: string): Promise<{ body: ArrayBuffer } | { refused: RoutedResponse }> {
    const body = await readBoundedBody(source, maxBodyBytes);
    if (body) return { body };
    guard.report({ reason: 'ingress.body_too_large', id: target.id, clientId });
    return { refused: { status: 413, headers: TEXT, body: 'The request body is too large.' } };
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
        releasePort(target.id, port);
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

  function detach(id: string): boolean {
    guard.release(id);
    const port = ports.get(id);
    if (port) releasePort(id, port);
    return !!port;
  }


  /** Judge the client (rebuilding its remap if it is a virtual-server page), then route the URL for it. */
  async function resolveForClient(url: URL, clientId: string, origin: string): Promise<PreviewTarget | null> {
    await guard.identify(clientId);
    return matchForClient(url, clientId, origin);
  }

  return { acceptAttach, mayAttach: guard.mayAttach, admit, readBody, match, matchForClient, needsClientLookup: guard.needsLookup, resolveForClient, rememberClient, respond, detach };
}

export type SwRouter = ReturnType<typeof createSwRouter>;
