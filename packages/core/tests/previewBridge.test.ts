import { describe, expect, it, vi } from 'vitest';
import { COOKIE_MESSAGE_TYPE, SOCKET_CONNECT_TIMEOUT_MS, SOCKET_MESSAGE_TYPE, bridgeInsertionPoint, previewCookieScript, previewSocketScript } from '../src/previewBridge.js';
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
    for (const script of [previewSocketScript(), previewCookieScript('a=1; b="</script>"')]) {
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
