/**
 * The preview service worker (bundled to dist/sw.js). It answers only requests
 * under the preview prefix; everything else falls through to the network
 * untouched, so registering it never changes how the host app itself loads.
 *
 * The routing rules (who may attach a port, which client may reach which
 * preview, the request-body limit) live in `swRouter`/`swBindings`; this file
 * only adapts worker events to them.
 *
 * Worker globals are typed locally rather than through `lib.webworker`, which
 * cannot share a compilation with the DOM lib the rest of the package needs.
 */
import { attachModeOf, createSwRouter, type AttachClient, type BodySource, type PortLike, type PreviewTarget, type RoutedResponse } from './swRouter.js';
import { ATTACH, REATTACH, isPortPath, type AttachMessage } from './protocol.js';

/** A `Client` (window or worker) as `event.source`, `clients.get` and `clients.matchAll` hand it over. */
interface ClientLike {
  id: string;
  url: string;
  type: string;
  postMessage(message: unknown): void;
}

interface MessageEventLike {
  data: unknown;
  ports: readonly unknown[];
  /** The sending client; a ServiceWorker or MessagePort (no `id`/`url`) or null otherwise. */
  source: ClientLike | object | null;
}

interface FetchEventLike {
  request: Request;
  clientId?: string;
  resultingClientId?: string;
  respondWith(response: Promise<Response>): void;
}

interface ServiceWorkerGlobalLike {
  /** The worker script's own URL: the relay registers `sw.js?mode=relay`. */
  location: { href: string };
  registration: { scope: string };
  clients: {
    get(id: string): Promise<ClientLike | undefined>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<ClientLike[]>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(type: 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

const worker = globalThis as unknown as ServiceWorkerGlobalLike;
const scope = new URL(worker.registration.scope);

const router = createSwRouter({
  scopePath: scope.pathname,
  attachMode: attachModeOf(worker.location.href),
  async requestReattach(id) {
    // Only pages that may attach are asked: a preview document must never get the chance to answer first.
    const pages = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const page of pages) if (router.mayAttach(page)) page.postMessage({ type: REATTACH, id });
  },
  getClient: (clientId) => worker.clients.get(clientId),
  onReject: (rejection) => console.warn(`[bfwc] ${rejection.reason}: ${rejection.message ?? rejection.id}`),
});

function asClient(source: MessageEventLike['source']): AttachClient | null {
  const client = source as Partial<ClientLike> | null;
  return client && typeof client.id === 'string' && typeof client.url === 'string' && typeof client.type === 'string'
    ? { id: client.id, url: client.url, type: client.type }
    : null;
}

worker.addEventListener('install', () => {
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('message', (event) => {
  const message = event.data as AttachMessage | null;
  const port = event.ports[0] as PortLike | undefined;
  if (message?.type !== ATTACH || !port) return;
  if (typeof message.id !== 'string') return port.close?.();
  void router.acceptAttach(message.id, port, asClient(event.source));
});

/** Statuses whose responses must not carry a body. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Forward a request a virtual server answers: method, headers and a size-limited body. */
async function toVirtualServer(target: PreviewTarget, request: Request, clientId: string | undefined): Promise<RoutedResponse> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => (headers[key] = value));
  let body: ArrayBuffer | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const read = await router.readBody(target, request as unknown as BodySource, clientId);
    if ('refused' in read) return read.refused;
    body = read.body;
  }
  return router.respond(target, { method: request.method, headers, body });
}

/** Only virtual Node servers take non-GET requests; the dev server serves files. */
const routable = (target: PreviewTarget, request: Request) => request.method === 'GET' || isPortPath(target.path);

/** Answer a routed request: the client binding, then the dev server or a virtual server. */
async function serve(event: FetchEventLike, target: PreviewTarget): Promise<Response> {
  const { request } = event;
  const toServer = isPortPath(target.path);
  const refused = await router.admit(target, event.clientId, event.resultingClientId);
  if (!refused && toServer) router.rememberClient(event.resultingClientId, target);
  const r = refused ?? (toServer ? await toVirtualServer(target, request, event.clientId) : await router.respond(target));
  // A virtual server's body is a stream fed as the server writes (SSE, chunked progress).
  if (NULL_BODY.has(r.status) && r.body instanceof ReadableStream) void r.body.cancel();
  return new Response(NULL_BODY.has(r.status) ? null : r.body, { status: r.status, headers: r.headers });
}

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const target = router.matchForClient(url, event.clientId, scope.origin);
  if (target) {
    if (routable(target, request)) event.respondWith(serve(event, target));
    return;
  }
  // Possibly a virtual-server page this worker forgot (restart): judge its client first.
  // GET/HEAD subresources only (never a navigation or a body); everything else stays on the network.
  if (!event.clientId || !router.needsClientLookup(url, event.clientId, scope.origin, request)) return;
  const clientId = event.clientId;
  event.respondWith(
    (async () => {
      const found = await router.resolveForClient(url, clientId, scope.origin);
      // Not a virtual-server page: the request goes on exactly as it was made.
      return found ? serve(event, found) : fetch(request);
    })(),
  );
});
