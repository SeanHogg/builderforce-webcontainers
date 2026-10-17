import { describe, expect, it } from 'vitest';
import { CONSOLE_MESSAGE_TYPE, COOKIE_MESSAGE_TYPE, PortCookieJars, SOCKET_MESSAGE_TYPE, connectWebSocket, type WebSocketCloseInfo } from '@seanhogg/builderforce-webcontainers-core';
import { createPortResponder, servePortRequest } from '../src/node/index.js';
import type { ProcessHost } from '../src/node/processHost.js';
import type { WireReply, WireRequest } from '../src/protocol.js';
import { host, readAll } from './helpers.js';

const decoder = new TextDecoder();
const text = (body: string | ArrayBuffer | null) => (typeof body === 'string' ? body : body ? decoder.decode(body) : '');

/** Run `server.js` in a fake worker and wait for its port. */
async function serve(source: string) {
  const { processes } = host({ 'server.js': source });
  const ready = new Promise<void>((resolve) => processes.servers.onListening(() => resolve()));
  const proc = processes.run('node', ['server.js']);
  const output = readAll(proc.combinedOutput);
  await ready;
  return { processes, proc, output };
}

function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('timed out waiting for a condition'));
      }
    }, 5);
  });
}

const request = (path: string, extra: Partial<WireRequest> = {}): WireRequest => ({ type: 'request', reqId: 1, path, search: '', method: 'GET', headers: {}, ...extra });

const SSE = `
  require('http').createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      res.write('data: ' + (++n) + '\\n\\n');
      if (n === 3 && req.url === '/finite') { clearInterval(timer); res.end(); }
    }, 10);
    req.on('close', () => { clearInterval(timer); console.log('client gone'); });
  }).listen(3000);
`;

describe('streaming through process workers', () => {
  it('streams a worker server response to the page chunk by chunk', async () => {
    const { processes, proc } = await serve(SSE);
    const response = await processes.requestStream(3000, { method: 'GET', url: '/finite', headers: {}, body: null });
    expect(response?.headers['content-type']).toBe('text/event-stream');
    const chunks: string[] = [];
    const reader = response!.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    expect(chunks).toEqual(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']);
    proc.kill();
    await proc.wait();
  });

  it('posts the head, then chunks, to the service worker, and hangs up on the server when the preview cancels', async () => {
    const { processes, proc, output } = await serve(SSE);
    const replies: WireReply[] = [];
    const responder = createPortResponder(processes);
    await responder.serve(request('/__port/3000/events', { reqId: 9 }), (reply) => replies.push(reply));
    expect(replies[0]).toMatchObject({ type: 'response', reqId: 9, status: 200, streaming: true, body: null });
    await until(() => replies.length >= 3);
    expect(replies.slice(1, 3).map((r) => (r.type === 'chunk' ? decoder.decode(r.data) : r.type))).toEqual(['data: 1\n\n', 'data: 2\n\n']);
    responder.cancel(9);
    await new Promise((resolve) => setTimeout(resolve, 50));
    proc.kill();
    await proc.wait();
    expect(await output).toContain('client gone');
  });

  it('breaks off a streaming body when the server process exits', async () => {
    const { processes, proc } = await serve(SSE);
    const response = await processes.requestStream(3000, { method: 'GET', url: '/', headers: {}, body: null });
    const reader = response!.body.getReader();
    await reader.read();
    proc.kill('SIGKILL');
    await expect((async () => {
      for (;;) if ((await reader.read()).done) return 'ended cleanly';
    })()).rejects.toThrow('The server process exited.');
  });
});

describe('websockets through process workers', () => {
  it('relays an upgraded connection between the page and the worker server', async () => {
    const { processes, proc } = await serve(`
      const http = require('http');
      const crypto = require('crypto');
      const server = http.createServer((req, res) => res.end('plain'));
      const frame = (op, payload) => Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]);
      server.on('upgrade', (req, socket) => {
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
        socket.on('data', (chunk) => {
          const length = chunk[1] & 0x7f, data = Buffer.alloc(length);
          for (let i = 0; i < length; i++) data[i] = chunk[6 + i] ^ chunk[2 + (i % 4)];
          if ((chunk[0] & 0x0f) === 8) { socket.write(frame(8, data)); return socket.end(); }
          socket.write(frame(1, Buffer.from('echo ' + data.toString())));
        });
      });
      server.listen(3000);
    `);
    const ws = connectWebSocket((req) => processes.upgrade(3000, req), { path: '/ws' });
    const messages: Array<string | Uint8Array> = [];
    ws.onMessage((data) => messages.push(data));
    const closed = new Promise<WebSocketCloseInfo>((resolve) => ws.onClose(resolve));
    await new Promise<void>((resolve) => ws.onOpen(() => resolve()));
    ws.send('ping');
    await until(() => messages.length > 0);
    expect(messages).toEqual(['echo ping']);
    ws.close(4000, 'done');
    expect(await closed).toEqual({ code: 4000, reason: 'done', wasClean: true });
    proc.kill();
    await proc.wait();
  });
});

const COOKIE_SERVER = `
  require('http').createServer((req, res) => {
    if (req.url === '/login') {
      res.setHeader('Set-Cookie', ['sid=s3cret; Path=/; HttpOnly', 'theme=dark; Path=/']);
      return res.end('ok');
    }
    if (req.url === '/logout') {
      res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
      return res.end('bye');
    }
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html');
      res.setHeader('content-length', '200');
      return res.end('<!doctype html><html><head><title>p</title></head><body>hi</body></html>');
    }
    res.end('cookie: ' + (req.headers.cookie || '-'));
  }).listen(3000);
`;

async function get(processes: ProcessHost, path: string, cookies: PortCookieJars, headers: Record<string, string> = {}) {
  return (await servePortRequest(processes, request(`/__port/3000${path}`, { headers }), { cookies })).message;
}

describe('cookies from virtual servers', () => {
  it('keeps Set-Cookie in the jar and sends it back, replacing the browser cookies', async () => {
    const { processes, proc } = await serve(COOKIE_SERVER);
    const cookies = new PortCookieJars();
    const login = await get(processes, '/login', cookies);
    expect(Object.keys(login.headers).map((k) => k.toLowerCase())).not.toContain('set-cookie');
    expect(text((await get(processes, '/me', cookies, { cookie: 'host-session=leak' })).body)).toBe('cookie: sid=s3cret; theme=dark');
    expect(cookies.jar(3000).documentCookie('/')).toBe('theme=dark');
    await get(processes, '/logout', cookies);
    expect(text((await get(processes, '/me', cookies)).body)).toBe('cookie: theme=dark');
    proc.kill();
    await proc.wait();
  });

  it('injects the bridge after <head> in HTML pages, with document.cookie seeded from the jar', async () => {
    const { processes, proc } = await serve(COOKIE_SERVER);
    const cookies = new PortCookieJars();
    await get(processes, '/login', cookies);
    const page = await get(processes, '/page', cookies);
    const html = text(page.body);
    expect(html.startsWith('<!doctype html><html><head><script>')).toBe(true);
    expect(html).toContain(SOCKET_MESSAGE_TYPE);
    expect(html).toContain(COOKIE_MESSAGE_TYPE);
    expect(html).toContain(CONSOLE_MESSAGE_TYPE); // errors and console reach the host from virtual servers too
    expect(html).toContain('"theme=dark"');
    expect(html).not.toContain('s3cret');
    expect(html.endsWith('<title>p</title></head><body>hi</body></html>')).toBe(true);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-length']).toBeUndefined();
    proc.kill();
    await proc.wait();
  });
});
