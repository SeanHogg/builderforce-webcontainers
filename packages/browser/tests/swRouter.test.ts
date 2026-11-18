import { describe, expect, it } from 'vitest';
import { attachModeOf, createSwRouter, readBoundedBody, type AttachClient, type AttachMode, type BodySource, type IngressRejection, type PortLike, type SwRouter } from '../src/swRouter.js';
import { isWireAttached, isWireRequest, previewBase, previewPrefix, randomNonce, type AttachProof } from '../src/protocol.js';
import { createRecentMap } from '../src/swBindings.js';

/** Each attacher's last nonce per preview id: like the host page, a fresh nonce per attach, chained to the last. */
const lastNonce = new Map<string, string>();

/** Attach as `client` with a fresh, chained nonce (`proof` overrides it). */
function acceptAttach(router: SwRouter, id: string, port: PortLike, client: AttachClient | null, proof?: AttachProof | null) {
  if (proof === undefined) {
    const key = `${client?.id}:${id}`;
    const nonce = randomNonce();
    const previous = lastNonce.get(key);
    lastNonce.set(key, nonce);
    proof = previous === undefined ? { nonce } : { nonce, previous };
  }
  return router.acceptAttach(id, port, client, proof);
}

/** The same-origin host page: the page that attaches previews in the routing tests. */
const HOST_PAGE: AttachClient = { id: 'host', type: 'window', url: 'https://h.test/editor' };
const attachTo = (router: SwRouter, id: string, port: PortLike) => acceptAttach(router, id, port, HOST_PAGE);

/** A page-side fake: answers every request with the path it was asked for (the worker's attach acknowledgements kept apart). */
function answeringPort(): PortLike & { requests: unknown[]; acks: unknown[] } {
  const port: PortLike & { requests: unknown[]; acks: unknown[] } = {
    requests: [],
    acks: [],
    onmessage: null,
    postMessage(message) {
      if (isWireAttached(message)) return void port.acks.push(message);
      port.requests.push(message);
      if (!isWireRequest(message)) return;
      queueMicrotask(() =>
        port.onmessage?.({
          data: { type: 'response', reqId: message.reqId, status: 200, headers: { 'content-type': 'text/plain' }, body: `served ${message.path}${message.search}` },
        }),
      );
    },
  };
  return port;
}

const silentPort = (): PortLike => ({ onmessage: null, postMessage() {} });

describe('preview prefix', () => {
  it('adds the segment under a root scope and reuses a dedicated one', () => {
    expect(previewPrefix('/')).toBe('/__bfwc/');
    expect(previewPrefix('/__bfwc/')).toBe('/__bfwc/');
    expect(previewPrefix('/app')).toBe('/app/__bfwc/');
    expect(previewBase('/__bfwc/', 'p1')).toBe('/__bfwc/p1/');
  });
});

describe('createSwRouter', () => {
  it('matches only preview URLs and splits id, path and query', () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    expect(router.match(new URL('https://x.dev/__bfwc/p1/src/main.tsx?import'))).toEqual({ id: 'p1', path: '/src/main.tsx', search: '?import' });
    expect(router.match(new URL('https://x.dev/__bfwc/p1'))).toEqual({ id: 'p1', path: '/', search: '' });
    expect(router.match(new URL('https://x.dev/dashboard'))).toBeNull();
    expect(router.match(new URL('https://x.dev/__bfwc/'))).toBeNull();
  });

  it('leaves files beside the worker (dotted names) to the network', () => {
    const router = createSwRouter({ scopePath: '/__bfwc/', requestReattach() {} });
    expect(router.match(new URL('https://p.example/__bfwc/relay.html'))).toBeNull();
    expect(router.match(new URL('https://p.example/__bfwc/sw.js'))).toBeNull();
    expect(router.match(new URL('https://p.example/__bfwc/abc123/index.html'))?.id).toBe('abc123');
  });

  it('forwards a request to the attached page and returns its answer', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    await attachTo(router, 'p1', answeringPort());
    const res = await router.respond({ id: 'p1', path: '/src/App.tsx', search: '?x' });
    expect(res).toMatchObject({ status: 200, body: 'served /src/App.tsx?x' });
  });

  it('asks pages to re-attach when the worker has forgotten the port', async () => {
    const asked: string[] = [];
    const router = createSwRouter({
      scopePath: '/',
      requestReattach(id) {
        asked.push(id);
        setTimeout(() => void attachTo(router, id, answeringPort()), 5);
      },
    });
    const res = await router.respond({ id: 'p9', path: '/', search: '' });
    expect(asked).toEqual(['p9']);
    expect(res.status).toBe(200);
  });

  it('answers 503 when no page re-attaches', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, reattachWaitMs: 10 });
    expect((await router.respond({ id: 'gone', path: '/', search: '' })).status).toBe(503);
  });

  it('times out a silent page and drops its port so the next request re-attaches', async () => {
    let reattached = 0;
    const router = createSwRouter({
      scopePath: '/',
      timeoutMs: 10,
      reattachWaitMs: 10,
      requestReattach(id) {
        reattached++;
        void attachTo(router, id, answeringPort());
      },
    });
    await attachTo(router, 'p1', silentPort());
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(504);
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
    expect(reattached).toBe(1);
  });
});

describe('virtual server routing', () => {
  it('forwards method, headers and body for /__port/ requests', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const port = answeringPort();
    await attachTo(router, 'p1', port);
    const body = new TextEncoder().encode('x').buffer as ArrayBuffer;
    await router.respond({ id: 'p1', path: '/__port/3000/api', search: '' }, { method: 'POST', headers: { a: 'b' }, body });
    expect(port.requests[0]).toMatchObject({ path: '/__port/3000/api', method: 'POST', headers: { a: 'b' } });
  });

  it('maps absolute URLs from a page served by a virtual server back under its port', () => {
    const router = createSwRouter({ scopePath: '/__bfwc/', requestReattach() {} });
    const page = router.match(new URL('https://h.test/__bfwc/p1/__port/3000/'))!;
    router.rememberClient('client-1', page);
    expect(router.matchForClient(new URL('https://h.test/style.css?v=1'), 'client-1', 'https://h.test')).toEqual({ id: 'p1', path: '/__port/3000/style.css', search: '?v=1' });
    expect(router.matchForClient(new URL('https://cdn.test/x.js'), 'client-1', 'https://h.test')).toBeNull();
    expect(router.matchForClient(new URL('https://h.test/style.css'), 'other', 'https://h.test')).toBeNull();
  });
});

describe('streamed responses', () => {
  /** A page that answers with a streaming head, then whatever the test pushes. */
  function streamingPort() {
    const sent: unknown[] = [];
    const port: PortLike & { push(message: unknown): void; sent: unknown[] } = {
      sent,
      onmessage: null,
      postMessage(message) {
        if (isWireAttached(message)) return; // the worker's attach acknowledgement
        sent.push(message);
        if (!isWireRequest(message)) return;
        queueMicrotask(() => port.onmessage?.({ data: { type: 'response', reqId: message.reqId, status: 200, headers: { 'content-type': 'text/event-stream' }, body: null, streaming: true } }));
      },
      push: (message) => port.onmessage?.({ data: message }),
    };
    return port;
  }
  const encode = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

  it('answers with a ReadableStream fed by chunk messages until end', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, timeoutMs: 20 });
    const port = streamingPort();
    await attachTo(router, 'p1', port);
    const res = await router.respond({ id: 'p1', path: '/__port/3000/events', search: '' }, { method: 'GET', headers: {}, body: null });
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(ReadableStream);
    const reqId = (port.sent[0] as { reqId: number }).reqId;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Long past the head timeout: an open stream is never timed out.
    await new Promise((resolve) => setTimeout(resolve, 40));
    port.push({ type: 'chunk', reqId, data: encode('data: 1') });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1');
    port.push({ type: 'chunk', reqId, data: encode('data: 2') });
    port.push({ type: 'end', reqId });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2');
    expect((await reader.read()).done).toBe(true);
  });

  it('tells the page to hang up when the preview cancels the body', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const port = streamingPort();
    await attachTo(router, 'p1', port);
    const res = await router.respond({ id: 'p1', path: '/__port/3000/events', search: '' }, { method: 'GET', headers: {}, body: null });
    const reqId = (port.sent[0] as { reqId: number }).reqId;
    await (res.body as ReadableStream<Uint8Array>).cancel();
    expect(port.sent[1]).toEqual({ type: 'cancel', reqId });
  });

  it('errors the stream when the page reports a broken body', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const port = streamingPort();
    await attachTo(router, 'p1', port);
    const res = await router.respond({ id: 'p1', path: '/__port/3000/', search: '' }, { method: 'GET', headers: {}, body: null });
    const reqId = (port.sent[0] as { reqId: number }).reqId;
    port.push({ type: 'end', reqId, error: 'The server process exited.' });
    await expect((res.body as ReadableStream<Uint8Array>).getReader().read()).rejects.toThrow('The server process exited.');
  });
});

/** A client on the preview origin `https://p.test`, whose worker scope is `/__bfwc/`. */
const client = (id: string, path: string, type = 'window'): AttachClient => ({ id, type, url: path.includes(':') ? path : `https://p.test${path}` });
/** The relay page as the worker sees it: framed (`nested`) by the host. */
const relay = (id: string): AttachClient => ({ ...client(id, '/__bfwc/relay.html'), frameType: 'nested' });

/** A router on a dedicated `/__bfwc/` scope over a controllable set of open clients. */
function guarded(open: AttachClient[] = [], attachMode?: AttachMode) {
  const live = new Map(open.map((c) => [c.id, c]));
  const rejections: IngressRejection[] = [];
  const router = createSwRouter({
    scopePath: '/__bfwc/',
    requestReattach() {},
    reattachWaitMs: 10,
    attachMode,
    getClient: async (clientId) => live.get(clientId),
    onReject: (rejection) => rejections.push(rejection),
  });
  return { router, rejections, live };
}

function closablePort() {
  const port = answeringPort() as ReturnType<typeof answeringPort> & { closed: boolean; close(): void };
  port.closed = false;
  port.close = () => void (port.closed = true);
  return port;
}

describe('attach integrity', () => {
  it('reads the attach mode from the worker script URL', () => {
    expect(attachModeOf('https://p.test/__bfwc/sw.js?mode=relay')).toBe('relay');
    expect(attachModeOf('https://h.test/__bfwc/sw.js')).toBe('same-origin');
  });

  it('accepts an attach from the relay page in either mode and serves the preview over it', async () => {
    for (const mode of ['relay', 'same-origin'] as const) {
      const { router } = guarded([], mode);
      expect(await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'))).toBe(true);
      expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
    }
  });

  it('accepts a same-origin host page outside the preview namespace only in same-origin mode', async () => {
    const host = client('host', '/editor');
    expect(await acceptAttach(guarded([], 'same-origin').router, 'p1', answeringPort(), host)).toBe(true);
    const relayMode = guarded([], 'relay');
    expect(await acceptAttach(relayMode.router, 'p1', closablePort(), host)).toBe(false);
    expect(relayMode.rejections[0]).toMatchObject({ reason: 'ingress.attach_rejected', detail: 'not_attacher', clientId: 'host' });
  });

  it('refuses attaches from preview documents, about:/blob: documents, workers and unknown sources, closing the port', async () => {
    const { router, rejections } = guarded();
    const offers: Array<AttachClient | null> = [
      client('doc', '/__bfwc/p1/index.html'),
      client('blank', 'about:blank'),
      client('blob', 'blob:https://p.test/5d1c'),
      client('w', '/__bfwc/relay.html', 'worker'),
      null,
    ];
    for (const from of offers) {
      const port = closablePort();
      expect(await acceptAttach(router, 'p2', port, from)).toBe(false);
      expect(port.closed).toBe(true);
    }
    expect(rejections.map((r) => [r.reason, r.detail])).toEqual(offers.map(() => ['ingress.attach_rejected', 'not_attacher']));
    expect(rejections[0]).toMatchObject({ id: 'p2', clientId: 'doc' });
    expect((await router.respond({ id: 'p2', path: '/', search: '' })).status).toBe(503);
  });

  it('refuses an id that is not a preview id', async () => {
    const { router, rejections } = guarded();
    expect(await acceptAttach(router, '../x', closablePort(), relay('relay-1'))).toBe(false);
    expect(rejections[0]?.detail).toBe('bad_id');
  });

  it('never lets a second open tab take a live preview, and says why', async () => {
    const { router, rejections } = guarded([relay('relay-1'), relay('relay-2')]);
    const owner = answeringPort();
    await acceptAttach(router, 'p1', owner, relay('relay-1'));
    const thief = closablePort();
    expect(await acceptAttach(router, 'p1', thief, relay('relay-2'))).toBe(false);
    expect(thief.closed).toBe(true);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ reason: 'ingress.attach_rejected', id: 'p1', clientId: 'relay-2', detail: 'duplicate_id' });
    expect(rejections[0]?.message).toContain("preview id 'p1' is already attached by another open tab; preview ids must be unique per tab");
    await router.respond({ id: 'p1', path: '/x', search: '' });
    expect(owner.requests).toHaveLength(1);
    expect(thief.requests).toHaveLength(0);
  });

  it('lets the owning client re-attach with a fresh port and closes the one it replaces', async () => {
    const { router } = guarded([relay('relay-1')]);
    const old = closablePort();
    await acceptAttach(router, 'p1', old, relay('relay-1'));
    const fresh = answeringPort();
    expect(await acceptAttach(router, 'p1', fresh, relay('relay-1'))).toBe(true);
    expect(old.closed).toBe(true);
    expect(old.onmessage).toBeNull();
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
    expect(old.requests).toHaveLength(0);
  });

  it('moves a preview to a new relay once the bound client is gone', async () => {
    const { router, live } = guarded([relay('relay-1')]);
    await acceptAttach(router, 'p1', silentPort(), relay('relay-1'));
    live.delete('relay-1'); // the tab closed
    const next = answeringPort();
    expect(await acceptAttach(router, 'p1', next, relay('relay-2'))).toBe(true);
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
    expect(next.requests).toHaveLength(1);
  });

  it('keeps the binding when the liveness check fails', async () => {
    const router = createSwRouter({
      scopePath: '/__bfwc/',
      requestReattach() {},
      getClient: async () => {
        throw new Error('clients.get failed');
      },
    });
    await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'));
    expect(await acceptAttach(router, 'p1', answeringPort(), relay('relay-2'))).toBe(false);
  });

  it('re-judges a claim whose liveness answer went stale while the binding moved and came back', async () => {
    const calls: Array<{ clientId: string; answer(client: AttachClient | undefined): void }> = [];
    const router = createSwRouter({
      scopePath: '/__bfwc/',
      requestReattach() {},
      getClient: (clientId) => new Promise((resolve) => calls.push({ clientId, answer: resolve })),
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await acceptAttach(router, 'p1', answeringPort(), relay('A'));
    const b = acceptAttach(router, 'p1', closablePort(), relay('B'));
    const c = acceptAttach(router, 'p1', answeringPort(), relay('C'));
    await tick();
    expect(calls.map((call) => call.clientId)).toEqual(['A', 'A']);
    calls[1]!.answer(undefined); // C learns A is gone and takes p1
    expect(await c).toBe(true);
    const a = acceptAttach(router, 'p1', answeringPort(), relay('A')); // A comes back; C has gone
    await tick();
    calls[2]!.answer(undefined);
    expect(await a).toBe(true);
    calls[0]!.answer(undefined); // B's stale answer: A was gone when it asked
    await tick();
    expect(calls[3]?.clientId).toBe('A'); // B asks again instead of taking p1 from the live A
    calls[3]!.answer(relay('A'));
    expect(await b).toBe(false);
  });

  it('refuses an attach without a well-formed nonce, closing the port', async () => {
    const { router, rejections } = guarded();
    for (const proof of [null, { nonce: 'short' }, { nonce: 'A'.repeat(32) }]) {
      const port = closablePort();
      expect(await acceptAttach(router, 'p1', port, relay('relay-1'), proof)).toBe(false);
      expect(port.closed).toBe(true);
    }
    expect(rejections.map((r) => r.detail)).toEqual(['bad_nonce', 'bad_nonce', 'bad_nonce']);
  });

  it('refuses a re-attach by the bound client without the current nonce, keeping the live port, and asks for a fresh attach', async () => {
    const asked: string[] = [];
    const rejections: IngressRejection[] = [];
    const router = createSwRouter({
      scopePath: '/__bfwc/',
      requestReattach: (id) => void asked.push(id),
      getClient: async (clientId) => (clientId === 'relay-1' ? relay('relay-1') : undefined),
      onReject: (rejection) => rejections.push(rejection),
    });
    const owner = answeringPort();
    expect(await acceptAttach(router, 'p1', owner, relay('relay-1'), { nonce: randomNonce() })).toBe(true);
    // A script posting as the relay client, without the host's nonce.
    const thief = closablePort();
    expect(await acceptAttach(router, 'p1', thief, relay('relay-1'), { nonce: randomNonce(), previous: randomNonce() })).toBe(false);
    expect(thief.closed).toBe(true);
    expect(rejections.map((r) => [r.reason, r.detail])).toEqual([['ingress.attach_rejected', 'stale_nonce']]);
    expect(asked).toEqual(['p1']);
    await router.respond({ id: 'p1', path: '/', search: '' });
    expect(owner.requests).toHaveLength(1);
  });

  it('recovers after a dropped attach: the stale chain is reset and the fresh attach it asks for is taken, never a lockout', async () => {
    const asked: string[] = [];
    const router = createSwRouter({ scopePath: '/__bfwc/', requestReattach: (id) => void asked.push(id), getClient: async () => relay('relay-1') });
    const acked = randomNonce();
    await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: acked });
    // The worker took a second attach whose acknowledgement the page never saw, so the page still chains from `acked`.
    await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: randomNonce(), previous: acked });
    expect(await acceptAttach(router, 'p1', closablePort(), relay('relay-1'), { nonce: randomNonce(), previous: randomNonce() })).toBe(false);
    expect(asked).toEqual(['p1']);
    // The page answers the REATTACH from where it believes the chain is: taken, and the chain runs on from it.
    const fresh = randomNonce();
    const port = answeringPort();
    expect(await acceptAttach(router, 'p1', port, relay('relay-1'), { nonce: fresh, previous: acked })).toBe(true);
    expect(port.acks).toEqual([{ type: 'attached', nonce: fresh }]);
    expect(await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: randomNonce(), previous: fresh })).toBe(true);
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
  });

  it("acknowledges an accepted attach on its port with that attach's nonce, and never a refused one", async () => {
    const { router } = guarded([relay('relay-1')]);
    const nonce = randomNonce();
    const accepted = answeringPort();
    await acceptAttach(router, 'p1', accepted, relay('relay-1'), { nonce });
    expect(accepted.acks).toEqual([{ type: 'attached', nonce }]);
    const refused = closablePort();
    await acceptAttach(router, 'p1', refused, client('doc', '/__bfwc/p1/'), { nonce: randomNonce() });
    expect(refused.acks).toEqual([]);
  });

  it('after a worker restart, refuses a first attach from anything but the framed relay page', async () => {
    // A fresh router is a restarted worker: no bindings, so only the attacher rules stand.
    const restarted = guarded([], 'relay');
    const foreign: AttachClient[] = [
      client('doc', '/__bfwc/p1/index.html'),
      { ...client('opened', '/__bfwc/relay.html'), frameType: 'auxiliary' }, // window.open('relay.html') from a preview
      { ...client('top', '/__bfwc/relay.html'), frameType: 'top-level' },
      client('unknown-frame', '/__bfwc/relay.html'),
    ];
    for (const from of foreign) expect(await acceptAttach(restarted.router, 'p1', closablePort(), from, { nonce: randomNonce() })).toBe(false);
    expect(restarted.rejections.map((r) => r.detail)).toEqual(foreign.map(() => 'not_attacher'));
    expect(await acceptAttach(restarted.router, 'p1', answeringPort(), relay('relay-1'), { nonce: randomNonce() })).toBe(true);
  });

  it('refuses a re-attach that presents a nonce the host already replaced', async () => {
    const { router, rejections } = guarded([relay('relay-1')]);
    const n1 = randomNonce();
    const n2 = randomNonce();
    await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: n1 });
    expect(await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: n2, previous: n1 })).toBe(true); // the host's REATTACH
    expect(await acceptAttach(router, 'p1', closablePort(), relay('relay-1'), { nonce: randomNonce(), previous: n1 })).toBe(false); // replays the stale one
    expect(rejections[0]?.detail).toBe('stale_nonce');
    expect(await acceptAttach(router, 'p1', answeringPort(), relay('relay-1'), { nonce: randomNonce(), previous: n2 })).toBe(true);
  });

  it('asks only pages that may attach to re-attach', () => {
    const sameOrigin = guarded().router;
    expect(sameOrigin.mayAttach(relay('r'))).toBe(true);
    expect(sameOrigin.mayAttach(client('host', '/editor'))).toBe(true);
    expect(sameOrigin.mayAttach(client('doc', '/__bfwc/p1/'))).toBe(false);
    expect(sameOrigin.mayAttach(client('blank', 'about:blank'))).toBe(false);
    const relayMode = guarded([], 'relay').router;
    expect(relayMode.mayAttach(relay('r'))).toBe(true);
    expect(relayMode.mayAttach(client('host', '/editor'))).toBe(false);
  });
});

describe('client binding', () => {
  const x = { id: 'px', path: '/', search: '' };
  const y = { id: 'py', path: '/', search: '' };

  it('binds the document a navigation creates and refuses its requests for another preview (403)', async () => {
    const { router, rejections } = guarded();
    // The host loads the iframe: browsers report no client for a navigation.
    expect(await router.admit(x, '', 'doc-x')).toBeNull();
    expect(await router.admit({ ...x, path: '/src/main.tsx' }, 'doc-x', undefined)).toBeNull();
    expect((await router.admit(y, 'doc-x', undefined))?.status).toBe(403);
    expect(rejections).toEqual([{ reason: 'ingress.client_not_bound', id: 'py', clientId: 'doc-x' }]);
    // A worker the document starts belongs to the same preview.
    expect(await router.admit({ ...x, path: '/worker.js' }, 'doc-x', 'worker-x')).toBeNull();
    expect((await router.admit(y, 'worker-x', undefined))?.status).toBe(403);
  });

  it('rebuilds a binding from the client URL after a restart', async () => {
    const { router } = guarded([client('doc-x', '/__bfwc/px/index.html'), client('worker-x', '/__bfwc/px/worker.js', 'worker')]);
    expect(await router.admit(x, 'doc-x', undefined)).toBeNull();
    expect((await router.admit(y, 'doc-x', undefined))?.status).toBe(403);
    expect((await router.admit(y, 'worker-x', undefined))?.status).toBe(403);
    expect(await router.admit(x, 'worker-x', undefined)).toBeNull();
  });

  it('refuses about:blank and srcdoc documents, blob: workers, process workers and unknown clients', async () => {
    const { router, rejections } = guarded([
      client('blank', 'about:blank'),
      client('srcdoc', 'about:srcdoc'),
      client('blob-worker', 'blob:https://p.test/5d1c', 'worker'),
      client('process', '/__bfwc/process-worker.js', 'worker'),
    ]);
    for (const clientId of ['blank', 'srcdoc', 'blob-worker', 'process', 'never-seen']) {
      expect((await router.admit(y, clientId, undefined))?.status).toBe(403);
    }
    expect(rejections.every((r) => r.reason === 'ingress.client_not_bound')).toBe(true);
  });

  it('lets a same-origin host page reach any preview without binding it', async () => {
    const { router } = guarded([client('host', '/editor')]);
    expect(await router.admit(x, 'host', undefined)).toBeNull();
    expect(await router.admit(y, 'host', undefined)).toBeNull();
  });

  it('in relay mode, treats only the relay page as a host page', async () => {
    const { router } = guarded([relay('relay'), client('stray', '/x')], 'relay');
    expect(await router.admit(x, 'relay', undefined)).toBeNull();
    expect((await router.admit(x, 'stray', undefined))?.status).toBe(403);
  });
});

describe('client binding after a restart and caching', () => {
  const x = { id: 'px', path: '/', search: '' };
  const y = { id: 'py', path: '/', search: '' };

  it('known limitation until control 1: blob: workers (Vite inline, Monaco, PDF.js) and srcdoc frames are refused', async () => {
    const { router } = guarded([
      client('vite-inline', 'blob:https://p.test/0b7e-vite', 'worker'),
      client('monaco', 'blob:https://p.test/editor.worker', 'worker'),
      client('pdfjs', 'blob:https://p.test/pdf.worker', 'worker'),
      client('srcdoc', 'about:srcdoc'),
    ]);
    for (const clientId of ['vite-inline', 'monaco', 'pdfjs', 'srcdoc']) expect((await router.admit(x, clientId, undefined))?.status).toBe(403);
  });

  it('binds a shared worker served under a preview to that preview', async () => {
    const { router } = guarded([client('shared-x', '/__bfwc/px/shared.js', 'sharedworker'), client('shared-blob', 'blob:https://p.test/1', 'sharedworker')]);
    expect(await router.admit(x, 'shared-x', undefined)).toBeNull();
    expect((await router.admit(y, 'shared-x', undefined))?.status).toBe(403);
    expect((await router.admit(x, 'shared-blob', undefined))?.status).toBe(403);
  });

  it('reuses a host page verdict for a few seconds instead of looking it up on every request', async () => {
    let time = 0;
    let lookups = 0;
    const host = client('host', '/editor');
    const router = createSwRouter({
      scopePath: '/__bfwc/',
      requestReattach() {},
      now: () => time,
      getClient: async () => {
        lookups++;
        return host;
      },
    });
    expect(await router.admit(x, 'host', undefined)).toBeNull();
    time = 4_000;
    expect(await router.admit(y, 'host', undefined)).toBeNull();
    expect(lookups).toBe(1);
    time = 6_000;
    expect(await router.admit(x, 'host', undefined)).toBeNull();
    expect(lookups).toBe(2);
  });

  it('rebuilds a virtual-server page remap after a restart so its absolute URLs still route', async () => {
    const { router } = guarded([client('port-page', '/__bfwc/px/__port/3000/index.html'), client('host', '/editor')]);
    const style = new URL('https://p.test/style.css?v=1');
    const GET = { method: 'GET', mode: 'no-cors' };
    expect(router.matchForClient(style, 'port-page', 'https://p.test')).toBeNull(); // forgotten
    expect(router.needsClientLookup(style, 'port-page', 'https://p.test', GET)).toBe(true);
    expect(await router.resolveForClient(style, 'port-page', 'https://p.test')).toEqual({ id: 'px', path: '/__port/3000/style.css', search: '?v=1' });
    expect(router.matchForClient(new URL('https://p.test/api'), 'port-page', 'https://p.test')).toEqual({ id: 'px', path: '/__port/3000/api', search: '' });
    // A host page is judged once and then left to the network.
    expect(await router.resolveForClient(style, 'host', 'https://p.test')).toBeNull();
    expect(router.needsClientLookup(style, 'host', 'https://p.test', GET)).toBe(false);
    // Never for cross-origin or preview-prefix URLs.
    expect(router.needsClientLookup(new URL('https://cdn.test/x.js'), 'other', 'https://p.test', GET)).toBe(false);
    expect(router.needsClientLookup(new URL('https://p.test/__bfwc/sw.js'), 'other', 'https://p.test', GET)).toBe(false);
  });

  it('never holds a non-GET request or a navigation from a client it has not judged', () => {
    const { router } = guarded([client('port-page', '/__bfwc/px/__port/3000/index.html')]);
    const api = new URL('https://p.test/api');
    expect(router.needsClientLookup(api, 'port-page', 'https://p.test', { method: 'POST', mode: 'cors' })).toBe(false);
    expect(router.needsClientLookup(api, 'port-page', 'https://p.test', { method: 'GET', mode: 'navigate' })).toBe(false);
    expect(router.needsClientLookup(api, 'port-page', 'https://p.test', { method: 'HEAD', mode: 'cors' })).toBe(true);
  });

  it('resolves a GET from a forgotten virtual-server page, after which its POST routes directly', async () => {
    const { router } = guarded([client('port-page', '/__bfwc/px/__port/3000/index.html')]);
    const api = new URL('https://p.test/api');
    expect(router.needsClientLookup(api, 'port-page', 'https://p.test', { method: 'GET', mode: 'cors' })).toBe(true);
    expect(await router.resolveForClient(api, 'port-page', 'https://p.test')).toEqual({ id: 'px', path: '/__port/3000/api', search: '' });
    // Re-judged: the next request (a POST included) matches synchronously, with no hold.
    expect(router.matchForClient(api, 'port-page', 'https://p.test')).toEqual({ id: 'px', path: '/__port/3000/api', search: '' });
    expect(router.needsClientLookup(api, 'port-page', 'https://p.test', { method: 'POST', mode: 'cors' })).toBe(false);
  });
});

describe('recent map', () => {
  it('forgets the least recently used entry, and a hit counts as use', () => {
    const map = createRecentMap<number>(2);
    map.set('a', 1);
    map.set('b', 2);
    expect(map.get('a')).toBe(1);
    map.set('c', 3);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
  });
});

describe('port release', () => {
  it('closes and stops listening to a port that timed out, and to a detached one', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, timeoutMs: 10, reattachWaitMs: 10 });
    const silent = Object.assign(silentPort(), { closed: false, close() { silent.closed = true; } });
    await attachTo(router, 'p1', silent);
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(504);
    expect(silent.closed).toBe(true);
    expect(silent.onmessage).toBeNull();
    const live = closablePort();
    await attachTo(router, 'p2', live);
    expect(router.detach('p2')).toBe(true);
    expect(live.closed).toBe(true);
    expect(live.onmessage).toBeNull();
    expect(router.detach('p2')).toBe(false);
  });
});

describe('request body limit', () => {
  const stream = (...chunks: number[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const size of chunks) controller.enqueue(new Uint8Array(size).fill(1));
        controller.close();
      },
    });
  const source = (body: ReadableStream<Uint8Array> | null | undefined, contentLength?: number, blobSize = 0): BodySource => ({
    headers: { get: (name) => (name === 'content-length' && contentLength !== undefined ? String(contentLength) : null) },
    body,
    blob: async () => ({ size: blobSize, arrayBuffer: async () => new ArrayBuffer(blobSize) }),
  });
  const target = { id: 'p1', path: '/__port/3000/upload', search: '' };

  it('passes a body within the limit through whole', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, maxBodyBytes: 10 });
    const read = await router.readBody(target, source(stream(4, 6)));
    expect('body' in read && read.body.byteLength).toBe(10);
  });

  it('answers 413 from Content-Length without reading the body', async () => {
    const rejections: IngressRejection[] = [];
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, maxBodyBytes: 10, onReject: (r) => rejections.push(r) });
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull: () => void (pulled = true) }, { highWaterMark: 0 });
    const read = await router.readBody(target, source(body, 11), 'doc-1');
    expect('refused' in read && read.refused.status).toBe(413);
    expect(pulled).toBe(false);
    expect(rejections).toEqual([{ reason: 'ingress.body_too_large', id: 'p1', clientId: 'doc-1' }]);
  });

  it('answers 413 when the bytes read pass the limit, and stops reading', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {}, maxBodyBytes: 10 });
    let cancelled = false;
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++;
        controller.enqueue(new Uint8Array(4));
      },
      cancel: () => void (cancelled = true),
    });
    const read = await router.readBody(target, source(endless));
    expect('refused' in read && read.refused.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(sent).toBeLessThanOrEqual(4);
  });

  it('checks the size of a Blob where request streams are unavailable', async () => {
    expect(await readBoundedBody(source(undefined, undefined, 11), 10)).toBeNull();
    expect((await readBoundedBody(source(undefined, undefined, 10), 10))?.byteLength).toBe(10);
  });

  it('reads a POST whose body is not exposed as a stream (null) through the Blob, never as empty', async () => {
    expect((await readBoundedBody(source(null, undefined, 5), 10))?.byteLength).toBe(5);
    expect(await readBoundedBody(source(null, undefined, 11), 10)).toBeNull();
  });

  it('defaults the limit to 32 MiB', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const read = await router.readBody(target, source(stream(1), 32 * 1024 * 1024 + 1));
    expect('refused' in read && read.refused.status).toBe(413);
  });
});
