/**
 * `http.createServer` on a virtual port. `listen(port)` registers a handler with
 * the system; each request arrives as plain data (from the preview service
 * worker, or `loopback` from inside the runtime), becomes an IncomingMessage /
 * ServerResponse pair for the app, and the finished response goes back as data.
 * Responses are buffered: streaming (SSE, long-polling) arrives in one piece.
 */
import { EventEmitterBase } from '../events.js';
import { Buffer } from '../buffer.js';
import { Readable } from '../stream/readable.js';
import { Writable } from '../stream/writable.js';
import type { EventLoop } from '../loop.js';
import type { HttpRequestData, HttpResponseData, System } from '../../system/types.js';
import { STATUS_CODES } from './status.js';

/** Enough of net.Socket for frameworks that read connection details. */
export class FakeSocket extends EventEmitterBase {
  remoteAddress = '127.0.0.1';
  remotePort = 50000 + Math.floor(Math.random() * 10000);
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort: number;
  encrypted = false;
  readable = true;
  writable = true;
  destroyed = false;
  bytesRead = 0;
  bytesWritten = 0;
  constructor(port = 0) {
    super();
    this.localPort = port;
  }
  setTimeout(_ms: number, cb?: () => void): this { if (cb) this.once('timeout', cb); return this; }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  address() { return { address: this.localAddress, family: 'IPv4', port: this.localPort }; }
  ref(): this { return this; }
  unref(): this { return this; }
  cork(): void {}
  uncork(): void {}
  write(): boolean { return true; }
  end(): this { return this; }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

function lowerHeaders(headers: Record<string, string>): { headers: Record<string, string | string[]>; raw: string[] } {
  const out: Record<string, string | string[]> = {};
  const raw: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    raw.push(key, value);
    out[k] = k === 'set-cookie' ? [value] : value;
  }
  return { headers: out, raw };
}

export class IncomingMessage extends Readable {
  httpVersion = '1.1';
  httpVersionMajor = 1;
  httpVersionMinor = 1;
  method?: string;
  url?: string;
  statusCode?: number;
  statusMessage?: string;
  headers: Record<string, string | string[]> = {};
  rawHeaders: string[] = [];
  trailers: Record<string, string> = {};
  rawTrailers: string[] = [];
  complete = false;
  aborted = false;
  socket: FakeSocket;
  connection: FakeSocket;

  constructor(socket: FakeSocket = new FakeSocket()) {
    super();
    this.socket = socket;
    this.connection = socket;
  }

  override _read(): void {
    // the body is pushed up front
  }

  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.once('timeout', cb);
    return this;
  }

  /** Fill from wire data; `body` null means none. */
  _fill(headers: Record<string, string>, body: Uint8Array | null): void {
    const { headers: lower, raw } = lowerHeaders(headers);
    this.headers = lower;
    this.rawHeaders = raw;
    if (body?.length) this.push(Buffer.from(body));
    this.push(null);
    this.complete = true;
  }
}

export class OutgoingHeaders extends Writable {
  protected _headers = new Map<string, { name: string; value: string | string[] }>();
  headersSent = false;
  sendDate = true;

  setHeader(name: string, value: string | number | readonly string[]): this {
    if (this.headersSent) throw Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
    this._headers.set(name.toLowerCase(), { name, value: Array.isArray(value) ? value.map(String) : String(value) });
    return this;
  }
  appendHeader(name: string, value: string | readonly string[]): this {
    const existing = this.getHeader(name);
    const list = [...(existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]), ...(Array.isArray(value) ? value : [value as string])];
    return this.setHeader(name, list);
  }
  getHeader(name: string): string | string[] | undefined {
    return this._headers.get(name.toLowerCase())?.value;
  }
  getHeaders(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = Object.create(null);
    for (const [key, { value }] of this._headers) out[key] = value;
    return out;
  }
  getHeaderNames(): string[] {
    return [...this._headers.keys()];
  }
  getRawHeaderNames(): string[] {
    return [...this._headers.values()].map((h) => h.name);
  }
  hasHeader(name: string): boolean {
    return this._headers.has(name.toLowerCase());
  }
  removeHeader(name: string): void {
    this._headers.delete(name.toLowerCase());
  }
  flushHeaders(): void {
    this.headersSent = true;
  }
  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.once('timeout', cb);
    return this;
  }
}

export class ServerResponse extends OutgoingHeaders {
  statusCode = 200;
  statusMessage = '';
  req: IncomingMessage;
  socket: FakeSocket;
  connection: FakeSocket;
  chunkedEncoding = false;
  shouldKeepAlive = false;
  private readonly chunks: Uint8Array[] = [];

  constructor(req: IncomingMessage, private readonly onDone: (response: HttpResponseData) => void) {
    super({ decodeStrings: true });
    this.req = req;
    this.socket = req.socket;
    this.connection = req.socket;
  }

  get finished(): boolean {
    return this.writableEnded;
  }

  writeHead(status: number, message?: string | Record<string, unknown> | unknown[], headers?: Record<string, unknown> | unknown[]): this {
    if (typeof message !== 'string') [headers, message] = [message, undefined];
    this.statusCode = status;
    if (message) this.statusMessage = message;
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2) this.setHeader(String(headers[i]), headers[i + 1] as string);
    } else if (headers) {
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) this.setHeader(k, v as string);
    }
    this.headersSent = true;
    return this;
  }
  writeContinue(): void {}
  writeProcessing(): void {}
  writeEarlyHints(): void {}
  addTrailers(): void {}
  assignSocket(): void {}
  detachSocket(): void {}

  override _write(chunk: Uint8Array, _encoding: string, callback: () => void): void {
    this.headersSent = true;
    this.chunks.push(chunk);
    callback();
  }

  override _final(callback: () => void): void {
    this.headersSent = true;
    const headers: Record<string, string | string[]> = {};
    for (const { name, value } of this._headers.values()) headers[name] = value;
    const body = Buffer.concat(this.chunks);
    if (this.req.method === 'HEAD') this.chunks.length = 0;
    this.onDone({ status: this.statusCode, statusText: this.statusMessage || STATUS_CODES[this.statusCode] || '', headers, body: this.req.method === 'HEAD' ? new Uint8Array() : body });
    callback();
  }
}

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
      this.registration = this.deps.system.listen(port, (request) => this.handle(request));
    } catch (error) {
      queueMicrotask(() => this.emit('error', error));
      return this;
    }
    this.listening = true;
    this.release = this.deps.loop.hold();
    queueMicrotask(() => this.emit('listening'));
    return this;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.registration ? { address: '::', family: 'IPv6', port: this.registration.port } : null;
  }

  close(callback?: (error?: Error) => void): this {
    if (!this.registration) {
      if (callback) queueMicrotask(() => callback(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
      return this;
    }
    this.registration.close();
    this.registration = undefined;
    this.listening = false;
    this.release?.();
    this.release = undefined;
    if (callback) this.once('close', callback);
    queueMicrotask(() => this.emit('close'));
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

  private handle(request: HttpRequestData): Promise<HttpResponseData> {
    return new Promise((resolve) => {
      const socket = new FakeSocket(this.registration?.port ?? 0);
      const req = new IncomingMessage(socket);
      req.method = request.method.toUpperCase();
      req.url = request.url;
      // Body parsers (body-parser/type-is) only read a body announced by
      // content-length or transfer-encoding; a browser-originated request
      // relayed by the service worker carries neither.
      const headers = { ...request.headers };
      const announced = Object.keys(headers).some((k) => /^(content-length|transfer-encoding)$/i.test(k));
      if (!announced && request.body?.length) headers['content-length'] = String(request.body.length);
      req._fill(headers, request.body);
      const res = new ServerResponse(req, resolve);
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
}
