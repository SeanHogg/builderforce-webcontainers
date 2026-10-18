/**
 * `http.createServer` on a virtual port. `listen(port)` registers a handler with
 * the system; each request arrives as plain data (from the preview service
 * worker, or `loopback` from inside the runtime) and becomes an IncomingMessage /
 * ServerResponse pair for the app. The response streams back as it is written
 * (see serverResponse.ts). Requests that ask to upgrade (WebSockets) go to the
 * `upgrade` listeners with a socket over the raw connection (upgradeSocket.ts).
 */
import { EventEmitterBase } from '../events.js';
import { Buffer } from '../buffer.js';
import type { EventLoop } from '../loop.js';
import type { ByteChannel, HttpRequestData, HttpStreamResponse, System } from '../../system/types.js';
import { pushStream } from '../../system/httpStream.js';
import { FakeSocket, IncomingMessage } from './messages.js';
import { ServerResponse } from './serverResponse.js';
import { UpgradeSocket } from './upgradeSocket.js';
import { queueCallback } from '../processExit.js';

export { FakeSocket, IncomingMessage, OutgoingHeaders } from './messages.js';
export { ServerResponse } from './serverResponse.js';
export { UpgradeSocket } from './upgradeSocket.js';

export interface ServerDeps {
  system: System;
  loop: EventLoop;
}

export class Server extends EventEmitterBase {
  listening = false;
  timeout = 0;
  keepAliveTimeout = 5000;
  headersTimeout = 60000;
  requestTimeout = 300000;
  maxHeadersCount: number | null = null;
  private registration?: { port: number; close(): void };
  private release?: () => void;

  constructor(private readonly deps: ServerDeps, options?: unknown, listener?: (req: IncomingMessage, res: ServerResponse) => void) {
    super();
    if (typeof options === 'function') listener = options as typeof listener;
    if (listener) this.on('request', listener);
  }

  listen(...args: unknown[]): this {
    const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as () => void) : undefined;
    const first = args[0];
    const port = typeof first === 'object' && first ? Number((first as { port?: number }).port ?? 0) : Number(first ?? 0);
    if (callback) this.once('listening', callback);
    try {
      this.registration = this.deps.system.listen(port, (request) => this.handle(request), (request, socket) => this.upgrade(request, socket));
    } catch (error) {
      queueCallback(() => this.emit('error', error));
      return this;
    }
    this.listening = true;
    this.release = this.deps.loop.hold();
    queueCallback(() => this.emit('listening'));
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.registration ? { address: '::', family: 'IPv6', port: this.registration.port } : null;
  }

  close(callback?: (error?: Error) => void): this {
    if (!this.registration) {
      if (callback) queueCallback(() => callback(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
      return this;
    }
    this.registration.close();
    this.registration = undefined;
    this.listening = false;
    this.release?.();
    this.release = undefined;
    if (callback) this.once('close', callback);
    queueCallback(() => this.emit('close'));
    return this;
  }

  closeAllConnections(): void {}
  closeIdleConnections(): void {}
  setTimeout(ms = 0, cb?: () => void): this {
    this.timeout = ms;
    if (cb) this.on('timeout', cb);
    return this;
  }
  ref(): this {
    if (this.registration && !this.release) this.release = this.deps.loop.hold();
    return this;
  }
  unref(): this {
    this.release?.();
    this.release = undefined;
    return this;
  }
  getConnections(cb: (error: null, count: number) => void): void {
    cb(null, 0);
  }

  private toIncoming(request: HttpRequestData, socket: FakeSocket, headers: Record<string, string>, body: Uint8Array | null): IncomingMessage {
    const req = new IncomingMessage(socket);
    req.method = request.method.toUpperCase();
    req.url = request.url;
    // HTTP/1.1 always names the host; servers check it (Vite's `allowedHosts` answers 403 without it).
    const named = Object.keys(headers).some((k) => k.toLowerCase() === 'host');
    req._fill(named ? headers : { ...headers, host: `localhost:${socket.localPort}` }, body);
    return req;
  }

  private handle(request: HttpRequestData): Promise<HttpStreamResponse> {
    return new Promise((resolve) => {
      // Body parsers (body-parser/type-is) only read a body announced by
      // content-length or transfer-encoding; a browser-originated request
      // relayed by the service worker carries neither.
      const headers = { ...request.headers };
      const announced = Object.keys(headers).some((k) => /^(content-length|transfer-encoding)$/i.test(k));
      if (!announced && request.body?.length) headers['content-length'] = String(request.body.length);
      const req = this.toIncoming(request, new FakeSocket(this.registration?.port ?? 0), headers, request.body);
      const body = pushStream(() => this.deps.loop._run(() => res._hangUp()));
      const res: ServerResponse = new ServerResponse(req, {
        head: (head) => resolve({ ...head, body: body.stream }),
        chunk: (data) => body.push(data),
        end: () => body.end(),
      });
      this.deps.loop._run(() => {
        try {
          this.emit('request', req, res);
        } catch (error) {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end('Internal Server Error');
          }
          throw error;
        }
      });
    });
  }

  /** A connection asking to upgrade: Node destroys it when nobody listens for `upgrade`. */
  private upgrade(request: HttpRequestData, channel: ByteChannel): void {
    if (!this.listenerCount('upgrade')) return channel.close();
    const socket = new UpgradeSocket(channel, this.registration?.port ?? 0, () => this.deps.loop.hold());
    const req = this.toIncoming(request, socket as unknown as FakeSocket, request.headers, null);
    this.deps.loop._run(() => this.emit('upgrade', req, socket, Buffer.alloc(0)));
  }
}
