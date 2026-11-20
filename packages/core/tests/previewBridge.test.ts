import { describe, expect, it, vi } from 'vitest';
import { COOKIE_MESSAGE_TYPE, SOCKET_CONNECT_TIMEOUT_MS, SOCKET_MESSAGE_TYPE, bridgeInsertionPoint, previewCookieScript, previewFetchScript, previewSocketScript } from '../src/previewBridge.js';
import { transformHtml, ERROR_MESSAGE_TYPE } from '../src/html.js';

describe('bridgeInsertionPoint', () => {
  it('goes right after <head>, whatever its attributes', () => {
    const html = '<!doctype html><html lang="en"><head data-x="1"><title>t</title>';
    expect(bridgeInsertionPoint(html)).toBe(html.indexOf('<title>'));
  });

  it('waits for more bytes while <head> may still come', () => {
    expect(bridgeInsertionPoint('<!doctype html><html><he')).toBeUndefined();
    expect(bridgeInsertionPoint('<!doctype html><html><he', true)).toBe('<!doctype html><html>'.length);
  });

  it('falls back to after <html> or the doctype (never before it), else the start', () => {
    expect(bridgeInsertionPoint('<!DOCTYPE html><html><body>hi')).toBe('<!DOCTYPE html><html>'.length);
    expect(bridgeInsertionPoint('<!DOCTYPE html><body>hi')).toBe('<!DOCTYPE html>'.length);
    expect(bridgeInsertionPoint('<div>fragment</div>')).toBe(0);
    expect(bridgeInsertionPoint('plain text', true)).toBe(0);
  });
});

describe('preview bridge scripts', () => {
  it('are self-contained scripts that parse', () => {
    for (const script of [previewSocketScript(), previewFetchScript(), previewCookieScript('a=1; b="</script>"')]) {
      const body = /^<script>([\s\S]*)<\/script>$/.exec(script)?.[1];
      expect(body).toBeDefined();
      expect(body).not.toMatch(/<\/script/i);
      expect(() => new Function(body!)).not.toThrow();
    }
    expect(previewSocketScript()).toContain(JSON.stringify(SOCKET_MESSAGE_TYPE));
    expect(previewCookieScript('')).toContain(JSON.stringify(COOKIE_MESSAGE_TYPE));
  });

  it('runs the WebSocket shim in dev-server documents, after the error bridge and before the app', () => {
    const out = transformHtml('<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>', { base: '/__bfwc/p1/' });
    const shim = out.indexOf(SOCKET_MESSAGE_TYPE);
    expect(shim).toBeGreaterThan(out.indexOf(ERROR_MESSAGE_TYPE));
    expect(shim).toBeLessThan(out.indexOf('src/main.tsx'));
  });
});

/** Run the WebSocket shim against a fake page under /__bfwc/p1/, capturing what it posts to the runtime. */
function socketShim() {
  const body = /^<script>([\s\S]*)<\/script>$/.exec(previewSocketScript())![1]!;
  const posted: Array<{ data: Record<string, unknown>; port: MessagePort }> = [];
  const listeners = new Map<string, Array<() => void>>();
  const runtime = { postMessage: (data: Record<string, unknown>, _origin: string, ports: MessagePort[]) => posted.push({ data, port: ports[0]! }) };
  const win: Record<string, unknown> = {
    parent: runtime,
    opener: null,
    WebSocket: class NativeWebSocket {},
    addEventListener: (type: string, listener: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  class CloseEvent extends Event {
    constructor(type: string, init: Record<string, unknown>) {
      super(type);
      Object.assign(this, init);
    }
  }
  new Function('window', 'location', 'CloseEvent', body)(win, new URL('https://preview.test/__bfwc/p1/index.html'), CloseEvent);
  const VirtualWebSocket = win.WebSocket as new (url: string) => { readyState: number; onclose: ((event: unknown) => void) | null };
  return { VirtualWebSocket, posted, fire: (type: string) => listeners.get(type)?.forEach((listener) => listener()) };
}

/** The first message the host end of a socket's channel receives. */
const hostHears = (port: MessagePort) => new Promise<Record<string, unknown>>((resolve) => (port.onmessage = (event) => resolve(event.data as Record<string, unknown>)));

describe('preview socket shim: telling the host the page is gone', () => {
  it('posts close for every open socket on pagehide', async () => {
    const shim = socketShim();
    const socket = new shim.VirtualWebSocket('ws://localhost:3000/hmr');
    expect(shim.posted[0]!.data).toMatchObject({ type: SOCKET_MESSAGE_TYPE, port: 3000, path: '/hmr' });
    const heard = hostHears(shim.posted[0]!.port);
    shim.fire('pagehide');
    expect(await heard).toEqual({ kind: 'close', code: 1001, reason: '' });
    expect(socket.readyState).toBe(3);
    shim.posted[0]!.port.close();
  });

  it('posts close when it gives up waiting for the host to connect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const shim = socketShim();
      const socket = new shim.VirtualWebSocket('ws://localhost:3000/hmr');
      const closed = new Promise((resolve) => (socket.onclose = resolve));
      const heard = hostHears(shim.posted[0]!.port);
      vi.advanceTimersByTime(SOCKET_CONNECT_TIMEOUT_MS);
      expect(await heard).toEqual({ kind: 'close', code: 1001, reason: '' });
      expect(await closed).toMatchObject({ code: 1006, wasClean: false });
      shim.posted[0]!.port.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Run the fetch/XHR/EventSource shim on a fake page at `href`, recording the URLs the native APIs are handed. */
function fetchShim(href: string) {
  const body = /^<script>([\s\S]*)<\/script>$/.exec(previewFetchScript())![1]!;
  const fetched: string[] = [];
  const opened: string[] = [];
  class NativeXhr {
    open(_method: string, url: string) {
      opened.push(url);
    }
  }
  class NativeEventSource {
    static OPEN = 1;
    constructor(readonly url: string) {}
  }
  const win: Record<string, unknown> = {
    fetch: (input: unknown) => fetched.push(input instanceof Request ? input.url : String(input)),
    XMLHttpRequest: NativeXhr,
    EventSource: NativeEventSource,
  };
  new Function('window', 'location', body)(win, new URL(href));
  return { win: win as { fetch(input: unknown): unknown; XMLHttpRequest: typeof NativeXhr; EventSource: new (url: string) => NativeEventSource }, fetched, opened, NativeEventSource };
}

describe('preview fetch shim: absolute localhost URLs of other services', () => {
  it('rewrites http://localhost:<port>/ to that port under the page’s preview path, leaving same-origin and external URLs alone', async () => {
    const shim = fetchShim('https://preview.test/__bfwc/p1/index.html');
    await shim.win.fetch('http://localhost:8000/items?x=1');
    await shim.win.fetch(new Request('http://127.0.0.1:8000/items', { method: 'POST', body: 'b' }));
    await shim.win.fetch('/api/items');
    await shim.win.fetch('https://cdn.test/a.js');
    expect(shim.fetched).toEqual([
      'https://preview.test/__bfwc/p1/__port/8000/items?x=1',
      'https://preview.test/__bfwc/p1/__port/8000/items',
      '/api/items',
      'https://cdn.test/a.js',
    ]);
    new shim.win.XMLHttpRequest().open('GET', 'http://localhost:8000/x');
    expect(shim.opened).toEqual(['https://preview.test/__bfwc/p1/__port/8000/x']);
    const events = new shim.win.EventSource('http://localhost:8000/events');
    expect(events.url).toBe('https://preview.test/__bfwc/p1/__port/8000/events');
    expect(events).toBeInstanceOf(shim.NativeEventSource);
  });

  it('does the same from a page a virtual server served, and nothing outside a preview', () => {
    const served = fetchShim('https://app.test/__bfwc/p1/__port/5173/');
    served.win.fetch('http://localhost:8000/items');
    expect(served.fetched).toEqual(['https://app.test/__bfwc/p1/__port/8000/items']);
    const outside = fetchShim('https://host.test/editor');
    outside.win.fetch('http://localhost:8000/items');
    expect(outside.fetched).toEqual(['http://localhost:8000/items']);
  });

  it('runs in dev-server documents beside the WebSocket shim', () => {
    expect(transformHtml('<html><head></head><body></body></html>', { base: '/__bfwc/p1/' })).toContain('__bfwcFetch');
  });
});
