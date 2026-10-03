/**
 * The preview service worker (bundled to dist/sw.js). It answers only requests
 * under the preview prefix; everything else falls through to the network
 * untouched, so registering it never changes how the host app itself loads.
 *
 * Worker globals are typed locally rather than through `lib.webworker`, which
 * cannot share a compilation with the DOM lib the rest of the package needs.
 */
import { createSwRouter, type PortLike } from './swRouter.js';
import { ATTACH, REATTACH, type AttachMessage } from './protocol.js';

interface WindowClientLike {
  postMessage(message: unknown): void;
}

interface ServiceWorkerGlobalLike {
  registration: { scope: string };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    claim(): Promise<void>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(type: 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown; ports: readonly unknown[] }) => void): void;
  addEventListener(
    type: 'fetch',
    listener: (event: { request: Request; respondWith(response: Promise<Response>): void }) => void,
  ): void;
}

const worker = globalThis as unknown as ServiceWorkerGlobalLike;

const router = createSwRouter({
  scopePath: new URL(worker.registration.scope).pathname,
  async requestReattach(id) {
    const pages = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const page of pages) page.postMessage({ type: REATTACH, id });
  },
});

worker.addEventListener('install', () => {
  void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(worker.clients.claim());
});

worker.addEventListener('message', (event) => {
  const message = event.data as AttachMessage | null;
  const port = event.ports[0];
  if (message?.type === ATTACH && typeof message.id === 'string' && port) router.attach(message.id, port as PortLike);
});

worker.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const target = router.match(new URL(event.request.url));
  if (!target) return;
  event.respondWith(router.respond(target).then((r) => new Response(r.body, { status: r.status, headers: r.headers })));
});
