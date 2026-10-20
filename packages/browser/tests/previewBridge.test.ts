import { afterEach, describe, expect, it } from 'vitest';
import { COOKIE_MESSAGE_TYPE, Kernel, PortCookieJars, SOCKET_MESSAGE_TYPE, defaultPrograms } from '@seanhogg/builderforce-webcontainers-core';
import { listenToPreviewBridge, type PreviewBridge } from '../src/previewBridge.js';

const ORIGIN = 'https://preview.test';
const BASE = '/__bfwc/p1/';

/** A window that hands the bridge MessageEvent-shaped objects, ports included. */
function fakeWindow() {
  let handler: ((event: MessageEvent) => void) | undefined;
  return {
    addEventListener: (_type: string, listener: EventListener) => void (handler = listener as (event: MessageEvent) => void),
    removeEventListener: () => void (handler = undefined),
    post: (origin: string, data: unknown, ports: MessagePort[] = []) => handler?.({ origin, data, ports } as unknown as MessageEvent),
  };
}

/** Messages arriving on the page's end of a channel. */
function inbox(port: MessagePort) {
  const messages: Array<Record<string, unknown>> = [];
  port.onmessage = (event) => messages.push(event.data as Record<string, unknown>);
  return {
    messages,
    async next(predicate: (m: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
      for (let i = 0; i < 400; i++) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('no such message arrived');
    },
  };
}

const ECHO_SERVER = `
  const http = require('http');
  const crypto = require('crypto');
  const server = http.createServer((req, res) => res.end('plain'));
  const frame = (op, payload) => Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]);
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
    socket.write(frame(1, Buffer.from(req.url + ' ' + (req.headers.cookie || '-') + ' ' + req.headers.origin)));
    socket.on('data', (chunk) => {
      const op = chunk[0] & 0x0f, length = chunk[1] & 0x7f, data = Buffer.alloc(length);
      for (let i = 0; i < length; i++) data[i] = chunk[6 + i] ^ chunk[2 + (i % 4)];
      if (op === 8) { socket.write(frame(8, data)); return socket.end(); }
      socket.write(frame(op, data));
    });
  });
  server.listen(3000);
`;

let bridge: PreviewBridge | undefined;
let stop: (() => void) | undefined;
afterEach(() => {
  bridge?.dispose();
  stop?.();
});

async function runtime() {
  const kernel = new Kernel({ programs: defaultPrograms() });
  kernel.fs.writeTree({ 'server.js': ECHO_SERVER });
  const ready = new Promise<void>((resolve) => kernel.servers.onListening(() => resolve()));
  const proc = kernel.run('node', ['server.js']);
  stop = () => proc.kill();
  await ready;
  const cookies = new PortCookieJars();
  const win = fakeWindow();
  bridge = listenToPreviewBridge(win, ORIGIN, BASE, { upgrade: (port, request) => kernel.upgrade(port, request), cookies });
  return { win, cookies };
}

describe('preview bridge: WebSockets', () => {
  it('connects a preview socket to the virtual server and relays text, binary and close', async () => {
    const { win, cookies } = await runtime();
    cookies.jar(3000).store('sid=abc; HttpOnly', '/');
    const channel = new MessageChannel();
    const page = inbox(channel.port1);
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}index.html`, port: 3000, path: '/live?x=1', protocols: [] }, [channel.port2]);

    expect(await page.next((m) => m.kind === 'open')).toEqual({ kind: 'open', protocol: '' });
    expect(await page.next((m) => m.kind === 'message')).toEqual({ kind: 'message', data: `/live?x=1 sid=abc ${ORIGIN}` });
    expect(bridge!.openSockets).toBe(1);

    channel.port1.postMessage({ kind: 'send', data: 'hello' });
    expect(await page.next((m) => m.data === 'hello')).toEqual({ kind: 'message', data: 'hello' });
    channel.port1.postMessage({ kind: 'send', data: new Uint8Array([7, 8]).buffer });
    const binary = await page.next((m) => m.data instanceof ArrayBuffer);
    expect(Array.from(new Uint8Array(binary.data as ArrayBuffer))).toEqual([7, 8]);

    channel.port1.postMessage({ kind: 'close', code: 1000, reason: 'bye' });
    expect(await page.next((m) => m.kind === 'close')).toEqual({ kind: 'close', code: 1000, reason: 'bye', wasClean: true });
    expect(bridge!.openSockets).toBe(0);
    channel.port1.close();
  });

  it('ignores other origins and other runtimes, and fails a socket to a port with no server', async () => {
    const { win } = await runtime();
    const spoof = new MessageChannel();
    const spoofed = inbox(spoof.port1);
    win.post('https://evil.test', { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}`, port: 3000, path: '/' }, [spoof.port2]);
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}/__bfwc/p2/`, port: 3000, path: '/' }, [spoof.port2]);
    const missing = new MessageChannel();
    const failed = inbox(missing.port1);
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}`, port: 4999, path: '/' }, [missing.port2]);
    expect(await failed.next()).toEqual({ kind: 'close', code: 1006, reason: '', wasClean: false });
    expect(spoofed.messages).toEqual([]);
    spoof.port1.close();
    missing.port1.close();
  });
});

describe('preview bridge: pages that go away', () => {
  it('hangs up on the server when the page port can no longer be posted to', async () => {
    const { win } = await runtime();
    let closed = false;
    const deadPort = {
      onmessage: null,
      postMessage: () => {
        throw new DOMException('The port is detached.', 'DataCloneError');
      },
      close: () => void (closed = true),
    };
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}`, port: 3000, path: '/hmr' }, [deadPort as unknown as MessagePort]);
    expect(bridge!.openSockets).toBe(1);
    for (let i = 0; i < 200 && bridge!.openSockets; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bridge!.openSockets).toBe(0);
    expect(closed).toBe(true);
  });

  it('requires the runtime nonce on socket requests when it has one', async () => {
    const { win, cookies } = await runtime();
    bridge!.dispose(); // this one without the kernel: count the upgrades a nonce lets through
    let upgrades = 0;
    bridge = listenToPreviewBridge(win, ORIGIN, BASE, { upgrade: () => (upgrades++, undefined), cookies, nonce: 'n0nce' });
    const without = new MessageChannel();
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}`, port: 3000, path: '/' }, [without.port2]);
    expect(bridge.openSockets).toBe(0);
    const withNonce = new MessageChannel();
    const page = inbox(withNonce.port1);
    win.post(ORIGIN, { type: SOCKET_MESSAGE_TYPE, href: `${ORIGIN}${BASE}`, nonce: 'n0nce', port: 3000, path: '/' }, [withNonce.port2]);
    expect(await page.next()).toMatchObject({ kind: 'close', code: 1006 }); // accepted; no upgrade answered
    expect(upgrades).toBe(1);
    without.port1.close();
    withNonce.port1.close();
  });
});

describe('preview bridge: document.cookie', () => {
  it('mirrors the jar into a virtual-server page and stores what the page assigns', async () => {
    const { win, cookies } = await runtime();
    const jar = cookies.jar(3000);
    jar.store(['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/'], '/');
    const channel = new MessageChannel();
    const page = inbox(channel.port1);
    win.post(ORIGIN, { type: COOKIE_MESSAGE_TYPE, href: `${ORIGIN}${BASE}__port/3000/app/index.html` }, [channel.port2]);
    expect(await page.next()).toEqual({ kind: 'cookies', value: 'theme=dark' });

    channel.port1.postMessage({ kind: 'set-cookie', value: 'lang=en; path=/' });
    expect(await page.next((m) => m.value === 'theme=dark; lang=en')).toBeTruthy(); // pushed back after the jar changed
    expect(jar.header('/')).toBe('sid=abc; theme=dark; lang=en');

    jar.store('theme=; Path=/; Max-Age=0', '/'); // the server deletes one
    expect(await page.next((m) => m.value === 'lang=en')).toBeTruthy();
    channel.port1.close();
  });
});
