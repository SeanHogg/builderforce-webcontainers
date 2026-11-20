import { describe, expect, it } from 'vitest';
import { createSwRouter, type AttachClient, type PortLike } from '../src/swRouter.js';
import { ingressRoutesOf, isWireRequest, matchIngressRoute, randomNonce, type WireIngressRoute } from '../src/protocol.js';

const ORIGIN = 'https://p.test';
const url = (path: string) => new URL(path, ORIGIN);
const client = (id: string, path: string): AttachClient => ({ id, type: 'window', url: `${ORIGIN}${path}` });
const RELAY: AttachClient = { ...client('relay', '/__bfwc/relay.html'), frameType: 'nested' };

/** The host's end, as the worker sees it: answers requests with their path, and records them. */
function hostPort(): PortLike & { requests: Array<Record<string, unknown>> } {
  const port: PortLike & { requests: Array<Record<string, unknown>> } = {
    requests: [],
    onmessage: null,
    postMessage(message) {
      if (!isWireRequest(message)) return;
      port.requests.push(message as unknown as Record<string, unknown>);
      queueMicrotask(() => port.onmessage?.({ data: { type: 'response', reqId: message.reqId, status: 200, headers: {}, body: `served ${message.path}` } }));
    },
  };
  return port;
}

/** The host sends a table on the attached port (what `previewAttach` does after every attach). */
const sendTable = (port: PortLike, routes: unknown) => port.onmessage?.({ data: { type: 'ingress', routes } });

const ROUTES: WireIngressRoute[] = [
  { path: '/', port: 5173 },
  { path: '/api', port: 8000 },
];

async function routerWithTable(routes: unknown = ROUTES, open: AttachClient[] = []) { // `null`: send no table
  const live = new Map([RELAY, ...open].map((c) => [c.id, c]));
  const reattachAsked: string[] = [];
  const router = createSwRouter({ scopePath: '/__bfwc/', attachMode: 'relay', reattachWaitMs: 50, requestReattach: (id) => void reattachAsked.push(id), getClient: async (id) => live.get(id) });
  const port = hostPort();
  expect(await router.acceptAttach('p1', port, RELAY, { nonce: randomNonce() })).toBe(true);
  if (routes !== null) sendTable(port, routes);
  return { router, port, reattachAsked };
}

describe('ingress tables on the wire', () => {
  it('keeps well-formed routes, longest first, and matches whole segments', () => {
    const routes = ingressRoutesOf({ type: 'ingress', routes: [{ path: '/', port: 5173 }, { path: '/api', port: 8000 }, { path: 'x', port: 1 }, { path: '/bad', port: 0 }, null] })!;
    expect(routes).toEqual([ { path: '/api', port: 8000 }, { path: '/', port: 5173 } ]);
    expect(matchIngressRoute(routes, '/api')?.port).toBe(8000);
    expect(matchIngressRoute(routes, '/api/items')?.port).toBe(8000);
    expect(matchIngressRoute(routes, '/apix')?.port).toBe(5173);
    expect(matchIngressRoute([{ path: '/api', port: 8000 }], '/apix')).toBeUndefined();
    expect(ingressRoutesOf({ type: 'request', routes: [] })).toBeNull();
  });
});

describe('service worker ingress routing', () => {
  it('routes a dev-server document’s requests outside the prefix by the longest route, the catch-all to the dev server', async () => {
    const { router } = await routerWithTable();
    // The navigation that created the document binds it to the preview.
    expect(await router.admit({ id: 'p1', path: '/index.html', search: '' }, undefined, 'doc')).toBeNull();
    expect(router.matchForClient(url('/api/items?q=1'), 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/api/items', search: '?q=1', from: { ingress: true } });
    expect(router.matchForClient(url('/logo.svg'), 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/logo.svg', search: '' });
    // Another origin, and a client bound to no preview (the host or relay page), are never routed.
    expect(router.matchForClient(new URL('https://api.test/api/items'), 'doc', ORIGIN)).toBeNull();
    expect(router.matchForClient(url('/api/items'), 'relay', ORIGIN)).toBeNull();
    expect(router.matchForClient(url('/api/items'), undefined, ORIGIN)).toBeNull();
  });

  it('routes a virtual-server page’s requests by the table’s non-catch-all routes, marked with the port that served it', async () => {
    const { router } = await routerWithTable();
    router.rememberClient('page', { id: 'p1', path: '/__port/5173/', search: '' });
    expect(router.matchForClient(url('/api/items'), 'page', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/api/items', search: '', from: { port: 5173, ingress: true } });
    // The catch-all never takes a virtual-server page's absolute URLs: its own server's remap does.
    expect(router.matchForClient(url('/style.css'), 'page', ORIGIN)).toEqual({ id: 'p1', path: '/__port/5173/style.css', search: '' });
  });

  it('a page a backend served keeps its absolute URLs; a dev-server document routes /api to the api and the rest to the dev server', async () => {
    const { router } = await routerWithTable();
    // A backend's own page (FastAPI docs at /__port/8000/docs) asking for /static/app.css: its server, never the frontend.
    router.rememberClient('docs', { id: 'p1', path: '/__port/8000/docs', search: '' });
    expect(router.matchForClient(url('/static/app.css'), 'docs', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/static/app.css', search: '' });
    expect(router.matchForClient(url('/api/x'), 'docs', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/api/x', search: '', from: { port: 8000, ingress: true } });
    // The dev-server document (the instant preview of the frontend).
    await router.admit({ id: 'p1', path: '/', search: '' }, undefined, 'doc');
    expect(router.matchForClient(url('/api/x'), 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/api/x', search: '', from: { ingress: true } });
    expect(router.matchForClient(url('/assets/logo.svg'), 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/assets/logo.svg', search: '' });
  });

  it('marks a page’s direct port request as the page’s, and leaves the host’s alone', async () => {
    const { router } = await routerWithTable();
    await router.admit({ id: 'p1', path: '/', search: '' }, undefined, 'doc');
    router.rememberClient('page', { id: 'p1', path: '/__port/5173/', search: '' });
    const direct = url('/__bfwc/p1/__port/8000/items');
    expect(router.matchForClient(direct, 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/items', search: '', from: {} });
    expect(router.matchForClient(direct, 'page', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/items', search: '', from: { port: 5173 } });
    expect(router.matchForClient(direct, 'relay', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/items', search: '' });
    expect(router.matchForClient(direct, undefined, ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/items', search: '' });
  });

  it('forwards who made the request to the page side', async () => {
    const { router, port } = await routerWithTable();
    const response = await router.respond({ id: 'p1', path: '/__port/8000/api', search: '', from: { ingress: true } }, { method: 'GET', headers: {}, body: null });
    expect(response.status).toBe(200);
    expect(port.requests[0]).toMatchObject({ path: '/__port/8000/api', from: { ingress: true } });
  });

  it('without a table (or after an empty one) routes nothing new: a port page keeps its own-server remap', async () => {
    const { router, port } = await routerWithTable(null);
    await router.admit({ id: 'p1', path: '/', search: '' }, undefined, 'doc');
    router.rememberClient('page', { id: 'p1', path: '/__port/3000/', search: '' });
    expect(router.matchForClient(url('/api/items'), 'doc', ORIGIN)).toBeNull();
    expect(router.matchForClient(url('/api/items'), 'page', ORIGIN)).toEqual({ id: 'p1', path: '/__port/3000/api/items', search: '' });
    sendTable(port, ROUTES);
    expect(router.matchForClient(url('/api/items'), 'doc', ORIGIN)?.path).toBe('/__port/8000/api/items');
    sendTable(port, []);
    expect(router.matchForClient(url('/api/items'), 'doc', ORIGIN)).toBeNull();
  });

  it('after a restart, a dev-server document waits for the re-attach to bring the table back', async () => {
    const doc = client('doc', '/__bfwc/p1/index.html');
    const live = new Map([RELAY, doc].map((c) => [c.id, c]));
    const port = hostPort();
    let router!: ReturnType<typeof createSwRouter>;
    router = createSwRouter({
      scopePath: '/__bfwc/',
      attachMode: 'relay',
      reattachWaitMs: 1_000,
      getClient: async (id) => live.get(id),
      // The host answers a re-attach request: attach, then the table on the new port.
      requestReattach: async (id) => {
        await router.acceptAttach(id, port, RELAY, { nonce: randomNonce() });
        sendTable(port, ROUTES);
      },
    });
    const items = url('/api/items');
    expect(router.needsClientLookup(items, 'doc', ORIGIN, { method: 'GET', mode: 'cors' })).toBe(true);
    expect(await router.resolveForClient(items, 'doc', ORIGIN)).toEqual({ id: 'p1', path: '/__port/8000/api/items', search: '', from: { ingress: true } });
  });
});
