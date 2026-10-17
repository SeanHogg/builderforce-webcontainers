/**
 * The message and socket objects both halves of `http` share: the socket
 * stand-in frameworks read connection details from, IncomingMessage (a request
 * a server receives, or a response a client receives) and the header store
 * behind ServerResponse and ClientRequest.
 */
import { EventEmitterBase } from '../events.js';
import { Buffer } from '../buffer.js';
import { Readable } from '../stream/readable.js';
import { Writable } from '../stream/writable.js';

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

export function lowerHeaders(headers: Record<string, string>): { headers: Record<string, string | string[]>; raw: string[] } {
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
    this._setHeaders(headers);
    if (body?.length) this.push(Buffer.from(body));
    this._complete();
  }

  /** Headers first, for a body that streams in through `push` and ends with `_complete`. */
  _setHeaders(headers: Record<string, string>): void {
    const { headers: lower, raw } = lowerHeaders(headers);
    this.headers = lower;
    this.rawHeaders = raw;
  }

  _complete(): void {
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
