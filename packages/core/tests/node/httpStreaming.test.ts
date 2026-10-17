import { describe, expect, it } from 'vitest';
import { kernelWith, readAll, runNode } from './helpers.js';
import { connectWebSocket, type WebSocketCloseInfo } from '../../src/system/webSocketClient.js';
import type { Kernel } from '../../src/system/kernel.js';

const decoder = new TextDecoder();

/** Resolve once `condition` holds (polled). */
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

/** Start `server.js` and wait for its port to open. */
async function serve(files: Record<string, string>): Promise<{ kernel: Kernel; output: Promise<string>; kill(): void }> {
  const kernel = kernelWith(files);
  const ready = new Promise<void>((resolve) => kernel.servers.onListening(() => resolve()));
  const proc = kernel.run('node', ['server.js']);
  const output = readAll(proc.combinedOutput);
  await ready;
  return { kernel, output, kill: () => proc.kill() };
}

async function chunksOf(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return chunks;
    chunks.push(decoder.decode(value));
  }
}

const SSE_SERVER = `
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let n = 0;
    const timer = setInterval(() => {
      res.write('data: ' + (++n) + '\\n\\n');
      if (n === 3) { clearInterval(timer); res.end(); }
    }, 15);
    req.on('close', () => clearInterval(timer));
  }).listen(3000);
`;

describe('streaming http', () => {
  it('delivers the head at writeHead and each write as its own chunk (Server-Sent Events)', async () => {
    const { kernel, kill } = await serve({ 'server.js': SSE_SERVER });
    const response = await kernel.requestStream(3000, { url: '/events' });
    expect(response?.status).toBe(200);
    expect(response?.headers['content-type']).toBe('text/event-stream');
    // Three separate chunks: nothing was buffered until the end.
    expect(await chunksOf(response!.body)).toEqual(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']);
    // The buffered form still returns the whole body.
    const whole = await kernel.request(3000, { url: '/events' });
    expect(decoder.decode(whole?.body)).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    kill();
  });

  it('tells the server when the client hangs up mid-stream', async () => {
    const { kernel, output } = await serve({
      'server.js': `
        const http = require('http');
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const timer = setInterval(() => res.write('tick\\n'), 5);
          req.on('close', () => { clearInterval(timer); console.log('client gone', req.aborted); server.close(); });
          res.on('close', () => console.log('response closed'));
        }).listen(3000);
      `,
    });
    const response = await kernel.requestStream(3000, { url: '/' });
    const reader = response!.body.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe('tick\n');
    await reader.cancel();
    expect(await output).toBe('client gone true\nresponse closed\n');
  });

  it('streams loopback responses to http.get and fetch inside the runtime', async () => {
    const { output, code } = await runNode({
      'index.js': `
        const http = require('http');
        let n = 0;
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'text/plain' });
          let i = 0;
          const timer = setInterval(() => { res.write('part' + (++i)); if (i === 3) { clearInterval(timer); res.end(); } }, 10);
        }).listen(0, () => {
          const port = server.address().port;
          http.get('http://localhost:' + port + '/', (res) => {
            const parts = [];
            res.on('data', (c) => parts.push(String(c)));
            res.on('end', async () => {
              console.log('http.get', parts.join('|'));
              const reader = (await fetch('http://localhost:' + port + '/')).body.getReader();
              const chunks = [];
              for (;;) { const { value, done } = await reader.read(); if (done) break; chunks.push(new TextDecoder().decode(value)); }
              console.log('fetch', chunks.join('|'));
              server.close();
            });
          });
        });
      `,
    });
    expect(output).toBe('http.get part1|part2|part3\nfetch part1|part2|part3\n');
    expect(code).toBe(0);
  });
});

/**
 * A WebSocket server written by hand on the `upgrade` event: the handshake with
 * crypto's sha1, and RFC 6455 framing — exactly what the `ws` package does over
 * the same socket.
 */
const WS_SERVER = `
  const http = require('http');
  const crypto = require('crypto');
  const server = http.createServer((req, res) => res.end('plain http'));
  const frame = (op, payload) => Buffer.concat([Buffer.from([0x80 | op, payload.length]), payload]);
  server.on('upgrade', (req, socket, head) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.setNoDelay(true);
    socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
    socket.write(frame(1, Buffer.from('welcome ' + req.url + ' ' + (req.headers.cookie || '-'))));
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 6) {
        const op = pending[0] & 0x0f, length = pending[1] & 0x7f;
        if (pending.length < 6 + length) break;
        const data = Buffer.alloc(length);
        for (let i = 0; i < length; i++) data[i] = pending[6 + i] ^ pending[2 + (i % 4)];
        pending = Buffer.from(pending.subarray(6 + length));
        if (op === 8) { socket.write(frame(8, data)); socket.end(); return; }
        if (op === 1) socket.write(frame(1, Buffer.from('echo ' + data.toString())));
        if (op === 2) socket.write(frame(2, Buffer.from(Array.from(data).reverse())));
      }
    });
    socket.on('close', () => { console.log('socket closed'); server.close(); });
  });
  server.listen(3000, () => console.log('listening'));
`;

describe('websocket upgrade', () => {
  it('hands upgrade requests to the server and carries text, binary and the close handshake', async () => {
    const { kernel, output } = await serve({ 'server.js': WS_SERVER });
    const ws = connectWebSocket((request) => kernel.upgrade(3000, request), { path: '/chat?room=1', headers: { cookie: 'sid=abc' } });
    const messages: Array<string | Uint8Array> = [];
    ws.onMessage((data) => messages.push(data));
    const closed = new Promise<WebSocketCloseInfo>((resolve) => ws.onClose(resolve));
    await new Promise<void>((resolve) => ws.onOpen(() => resolve()));
    expect(ws.readyState).toBe(1);
    await until(() => messages.length >= 1);
    expect(messages[0]).toBe('welcome /chat?room=1 sid=abc');

    ws.send('hi');
    ws.send(new Uint8Array([1, 2, 3]));
    await until(() => messages.length >= 3);
    expect(messages[1]).toBe('echo hi');
    expect(Array.from(messages[2] as Uint8Array)).toEqual([3, 2, 1]);

    ws.close(1000, 'bye');
    expect(await closed).toEqual({ code: 1000, reason: 'bye', wasClean: true });
    expect(await output).toBe('listening\nsocket closed\n');
  });

  it('fails the connection (1006) when nothing on the port takes upgrades', async () => {
    const { kernel, kill } = await serve({ 'server.js': `require('http').createServer((req, res) => res.end('x')).listen(3000);` });
    const noListener = connectWebSocket((request) => kernel.upgrade(3000, request), { path: '/' });
    expect(await new Promise((resolve) => noListener.onClose(resolve))).toEqual({ code: 1006, reason: '', wasClean: false });
    const noServer = connectWebSocket((request) => kernel.upgrade(4000, request), { path: '/' });
    expect(await new Promise((resolve) => noServer.onClose(resolve))).toEqual({ code: 1006, reason: '', wasClean: false });
    kill();
  });
});
