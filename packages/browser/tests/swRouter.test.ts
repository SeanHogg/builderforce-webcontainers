import { describe, expect, it } from 'vitest';
import { createSwRouter, type PortLike } from '../src/swRouter.js';
import { isWireRequest, previewBase, previewPrefix } from '../src/protocol.js';

/** A page-side fake: answers every request with the path it was asked for. */
function answeringPort(): PortLike & { requests: unknown[] } {
  const port: PortLike & { requests: unknown[] } = {
    requests: [],
    onmessage: null,
    postMessage(message) {
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
    router.attach('p1', answeringPort());
    const res = await router.respond({ id: 'p1', path: '/src/App.tsx', search: '?x' });
    expect(res).toMatchObject({ status: 200, body: 'served /src/App.tsx?x' });
  });

  it('asks pages to re-attach when the worker has forgotten the port', async () => {
    const asked: string[] = [];
    const router = createSwRouter({
      scopePath: '/',
      requestReattach(id) {
        asked.push(id);
        setTimeout(() => router.attach(id, answeringPort()), 5);
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
        router.attach(id, answeringPort());
      },
    });
    router.attach('p1', silentPort());
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(504);
    expect((await router.respond({ id: 'p1', path: '/', search: '' })).status).toBe(200);
    expect(reattached).toBe(1);
  });
});

describe('virtual server routing', () => {
  it('forwards method, headers and body for /__port/ requests', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const port = answeringPort();
    router.attach('p1', port);
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
    router.attach('p1', port);
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
    router.attach('p1', port);
    const res = await router.respond({ id: 'p1', path: '/__port/3000/events', search: '' }, { method: 'GET', headers: {}, body: null });
    const reqId = (port.sent[0] as { reqId: number }).reqId;
    await (res.body as ReadableStream<Uint8Array>).cancel();
    expect(port.sent[1]).toEqual({ type: 'cancel', reqId });
  });

  it('errors the stream when the page reports a broken body', async () => {
    const router = createSwRouter({ scopePath: '/', requestReattach() {} });
    const port = streamingPort();
    router.attach('p1', port);
    const res = await router.respond({ id: 'p1', path: '/__port/3000/', search: '' }, { method: 'GET', headers: {}, body: null });
    const reqId = (port.sent[0] as { reqId: number }).reqId;
    port.push({ type: 'end', reqId, error: 'The server process exited.' });
    await expect((res.body as ReadableStream<Uint8Array>).getReader().read()).rejects.toThrow('The server process exited.');
  });
});
