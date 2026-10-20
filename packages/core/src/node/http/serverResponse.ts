/**
 * ServerResponse, streamed: the head goes out on `writeHead`/`flushHeaders` or
 * the first write, each `write` is a body chunk, `end` ends the body. So
 * Server-Sent Events and chunked progress reach the client as they happen. A
 * client that hangs up mid-response is seen the way Node reports it.
 */
import type { HttpResponseHead } from '../../system/types.js';
import { STATUS_CODES } from './status.js';
import { FakeSocket, IncomingMessage, OutgoingHeaders } from './messages.js';

/** Where a response goes as it is written. */
export interface ResponseSink {
  head(head: HttpResponseHead): void;
  /** A body chunk; call `written` once there is room for the next (at once, or when a slow reader catches up). */
  chunk(data: Uint8Array, written: () => void): void;
  end(): void;
}

/** Statuses that never carry a body. */
const NO_BODY = new Set([101, 204, 304]);

export class ServerResponse extends OutgoingHeaders {
  statusCode = 200;
  statusMessage = '';
  req: IncomingMessage;
  socket: FakeSocket;
  connection: FakeSocket;
  chunkedEncoding = false;
  shouldKeepAlive = false;
  private headWritten = false;
  private hungUp = false;

  constructor(req: IncomingMessage, private readonly sink: ResponseSink) {
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
    this.sendHead();
    return this;
  }
  override flushHeaders(): void {
    this.sendHead();
  }
  /** Node internals that middleware (compression, on-headers) patch around: send the head now; is it out yet? */
  _implicitHeader(): void {
    this.sendHead();
  }
  get _header(): boolean {
    return this.headersSent;
  }
  writeContinue(): void {}
  writeProcessing(): void {}
  writeEarlyHints(): void {}
  addTrailers(): void {}
  assignSocket(): void {}
  detachSocket(): void {}

  override _write(chunk: Uint8Array, _encoding: string, callback: () => void): void {
    this.sendHead();
    // Backpressure: the write completes when the body has room, so `write()` returns false and 'drain' follows, as in Node.
    if (!this.hungUp && this.req.method !== 'HEAD' && !NO_BODY.has(this.statusCode)) this.sink.chunk(new Uint8Array(chunk), callback);
    else callback();
  }

  override _final(callback: () => void): void {
    this.sendHead();
    if (!this.hungUp) this.sink.end();
    callback();
  }

  /** The client went away (closed its EventSource, navigated off): `aborted`/`close` on the request, `close` here; later writes are dropped. */
  _hangUp(): void {
    if (this.hungUp || this.writableFinished) return;
    this.hungUp = true;
    this._writableState.emitClose = false;
    this.req.aborted = true;
    this.req.emit('aborted');
    this.req.emit('close');
    this.socket.destroyed = true;
    this.socket.emit('close', false);
    this.emit('close');
  }

  private sendHead(): void {
    this.headersSent = true;
    if (this.headWritten) return;
    this.headWritten = true;
    const headers: Record<string, string | string[]> = {};
    for (const { name, value } of this._headers.values()) headers[name] = value;
    this.sink.head({ status: this.statusCode, statusText: this.statusMessage || STATUS_CODES[this.statusCode] || '', headers });
  }
}
