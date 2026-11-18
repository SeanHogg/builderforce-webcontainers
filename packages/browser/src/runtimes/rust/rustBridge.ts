/**
 * The host side of the Rust runtime's service ABI (the guest side is the
 * bfwc-wasi crate, rust-fixtures/bfwc-wasi): the `bfwc` import module and the
 * driving of a reactor module that never blocks.
 *
 * - Serving (a wasi:http-style handler): during `bfwc_start` the module claims
 *   its port with `listen` (once; later calls answer -1); each request is
 *   written into its memory (`bfwc_alloc`) and handed to `bfwc_request` — a
 *   head of `METHOD URL` then `name:value` lines, and the body — and answered
 *   whole with `respond`. A status outside 200–599, or a body over
 *   {@link MAX_RESPONSE_BYTES}, answers 502 instead.
 * - Driving: the module runs its tasks only inside `bfwc_poll`, which the host
 *   calls (once per microtask turn at most) after anything that may let a task
 *   progress: a request, bytes, room to write or a hang-up on a connection, a
 *   dial resolving. No thread ever waits, so no SharedArrayBuffer.
 * - Virtual TCP: `connect` dials a port anywhere in the runtime (the Postgres
 *   gateway) through the one dial choke point (rustDial.ts) and answers a
 *   handle at once. Flow control is the shared connection core's
 *   (runtimes/channelEndpoint.ts): reads answer "would block" until bytes
 *   arrive and credit what they take, writes answer "would block" above the
 *   high-water mark, and reads answer end of file after the far end hangs up.
 *   At most {@link MAX_CONNECTIONS} are open at once.
 *
 * Every pointer and length from the guest is read as unsigned; one out of
 * bounds traps the module (the process ends) and fails the request it was for.
 */
import { bytesStream, textResponse, type ByteChannel, type HttpHandler, type HttpResponseHead, type HttpStreamResponse } from '@seanhogg/builderforce-webcontainers-core';
import { ChannelEndpoint, SEND_HIGH_WATER_MARK } from '../channelEndpoint.js';

export type Dial = (port: number) => Promise<ByteChannel | undefined>;

/** `recv`/`send`/`connect` results below zero (the bfwc-wasi crate's constants). */
export const WOULD_BLOCK = -1;
export const REFUSED = -2;
export const RESET = -3;

/** Open connections one process may hold. */
export const MAX_CONNECTIONS = 256;
/** The largest response body a service may answer with. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** The service ABI's exports. */
export interface RustServiceExports {
  memory: WebAssembly.Memory;
  bfwc_abi_version(): number;
  bfwc_start(): number;
  bfwc_alloc(length: number): number;
  bfwc_request(reqId: number, head: number, headLength: number, body: number, bodyLength: number): void;
  /** 1 when work remains (poll again soon), else 0. */
  bfwc_poll(): number;
}

export interface RustBridgeOptions {
  dial: Dial;
  /** The module trapped (or exited) while the host drove it: the process ends. */
  onFault(error: unknown): void;
  highWaterMark?: number;
}

export interface RustBridge {
  /** The `bfwc` import module. */
  readonly imports: Record<string, (...args: number[]) => number | void>;
  /** The port the module claimed with `listen`, if any. */
  readonly port: number | undefined;
  readonly handle: HttpHandler;
  attach(exports: RustServiceExports): void;
  /** `bfwc_start` returned: no more `listen`. */
  started(): void;
  /** Run the module's tasks soon. */
  schedule(): void;
  /** Fail every pending response and hang up every connection; the module is never called again. */
  close(): void;
}

interface Connection {
  state: 'dialling' | 'open' | 'refused';
  endpoint?: ChannelEndpoint;
  /** Writes before the dial resolved. */
  held: Uint8Array[];
  heldBytes: number;
}

interface Pending {
  resolve(response: HttpStreamResponse): void;
  reject(error: Error): void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/** An HTTP field name (RFC 9110 token). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** A request head as the guest parses it: no CR or LF inside a line. */
export function encodeHead(method: string, url: string, headers: Record<string, string>): Uint8Array {
  const clean = (text: string) => text.replace(/[\r\n]+/g, ' ');
  const lines = [`${clean(method)} ${clean(url)}`, ...Object.entries(headers).map(([name, value]) => `${clean(name)}:${clean(value)}`)];
  return encoder.encode(lines.join('\n'));
}

/** A response head from the guest: `name:value` lines; repeated names become arrays; names that are not tokens are dropped. */
export function decodeHeaders(text: string): HttpResponseHead['headers'] {
  // No prototype: a header called `constructor` or `__proto__` is a header like any other.
  const headers: HttpResponseHead['headers'] = Object.create(null);
  for (const line of text.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).toLowerCase();
    if (!TOKEN.test(name)) continue;
    const value = line.slice(at + 1);
    const existing = Object.hasOwn(headers, name) ? headers[name] : undefined;
    headers[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  // A plain object again (own data properties only, `__proto__` included), so it structured-clones as it reads.
  return Object.fromEntries(Object.entries(headers));
}

/** The response a guest's `respond` stands for: its own, or a 502 saying why not. */
function responseOf(status: number, headers: HttpResponseHead['headers'], body: Uint8Array): HttpStreamResponse {
  if (!Number.isInteger(status) || status < 200 || status > 599) return textResponse(502, `The Rust service answered with an invalid status (${status}).`);
  return { status, headers, body: bytesStream(body) };
}

export function createRustBridge(options: RustBridgeOptions): RustBridge {
  const highWaterMark = options.highWaterMark ?? SEND_HIGH_WATER_MARK;
  let exports: RustServiceExports | undefined;
  let port: number | undefined;
  let listening = true;
  let closed = false;
  let scheduled = false;
  let nextRequest = 1;
  let nextConnection = 1;
  const pending = new Map<number, Pending>();
  const connections = new Map<number, Connection>();

  /** Guest memory at an unsigned pointer and length; out of bounds throws (a trap). */
  function bytes(pointer: number, length: number): Uint8Array {
    const at = pointer >>> 0;
    const size = length >>> 0;
    const buffer = exports!.memory.buffer;
    if (at + size > buffer.byteLength) throw new RangeError(`memory access out of bounds (${at}+${size} > ${buffer.byteLength})`);
    return new Uint8Array(buffer, at, size);
  }

  function fault(error: unknown): void {
    if (closed) return;
    close();
    options.onFault(error);
  }

  function poll(): void {
    scheduled = false;
    if (closed || !exports) return;
    let more: number;
    try {
      more = exports.bfwc_poll();
    } catch (error) {
      return fault(error);
    }
    if (more && !scheduled) {
      // A task that keeps waking itself: let the event loop breathe first.
      scheduled = true;
      setTimeout(poll, 0);
    }
  }

  function schedule(): void {
    if (scheduled || closed || !exports) return;
    scheduled = true;
    queueMicrotask(poll);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) entry.reject(new Error('The process exited.'));
    pending.clear();
    for (const connection of connections.values()) connection.endpoint?.close();
    connections.clear();
  }

  /** Copy `data` into guest memory it owns from then on. */
  function give(data: Uint8Array): number {
    const pointer = exports!.bfwc_alloc(data.length) >>> 0;
    bytes(pointer, data.length).set(data);
    return pointer;
  }

  const handle: HttpHandler = (request) =>
    new Promise<HttpStreamResponse>((resolve, reject) => {
      if (closed || !exports) return reject(new Error('The Rust service is not running.'));
      const reqId = nextRequest++;
      pending.set(reqId, { resolve, reject });
      try {
        const head = encodeHead(request.method, request.url, request.headers);
        const body = request.body ?? new Uint8Array(0);
        const headAt = give(head);
        const bodyAt = give(body);
        exports.bfwc_request(reqId, headAt, head.length, bodyAt, body.length);
      } catch (error) {
        return fault(error);
      }
      schedule();
    });

  const imports: RustBridge['imports'] = {
    listen(requested) {
      if (!listening || !validPort(requested)) return -1;
      if (port !== undefined && port !== requested) return -1; // one served port per process
      port = requested;
      return 0;
    },
    respond(reqId, status, headAt, headLength, bodyAt, bodyLength) {
      const entry = pending.get(reqId >>> 0);
      if (!entry) return;
      let response: HttpStreamResponse;
      try {
        if (bodyLength >>> 0 > MAX_RESPONSE_BYTES) response = textResponse(502, `The Rust service's response is over ${MAX_RESPONSE_BYTES} bytes.`);
        else response = responseOf(status, decodeHeaders(decoder.decode(bytes(headAt, headLength))), bytes(bodyAt, bodyLength).slice());
      } catch (error) {
        pending.delete(reqId >>> 0);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
        throw error; // the guest's pointers were bad: trap it
      }
      pending.delete(reqId >>> 0);
      entry.resolve(response);
    },
    connect(target) {
      if (!validPort(target) || connections.size >= MAX_CONNECTIONS) return REFUSED;
      const id = nextConnection++;
      const connection: Connection = { state: 'dialling', held: [], heldBytes: 0 };
      connections.set(id, connection);
      options.dial(target).then(
        (channel) => {
          if (connections.get(id) !== connection) return channel?.close(); // the guest hung up first
          if (!channel) connection.state = 'refused';
          else {
            connection.state = 'open';
            const endpoint = new ChannelEndpoint(channel, schedule, highWaterMark);
            connection.endpoint = endpoint;
            for (const data of connection.held.splice(0)) endpoint.send(data);
            connection.heldBytes = 0;
          }
          schedule();
        },
        () => {
          connection.state = 'refused';
          schedule();
        },
      );
      return id;
    },
    send(id, at, length) {
      const connection = connections.get(id);
      if (!connection) return RESET;
      if (connection.state === 'refused') return REFUSED;
      const { endpoint } = connection;
      if (endpoint?.ended) return RESET;
      if (endpoint ? !endpoint.writable : connection.heldBytes > highWaterMark) return WOULD_BLOCK;
      const data = bytes(at, length).slice();
      if (endpoint) endpoint.send(data);
      else {
        connection.held.push(data);
        connection.heldBytes += data.length;
      }
      return data.length;
    },
    recv(id, at, length) {
      const connection = connections.get(id);
      if (!connection) return RESET;
      if (connection.state === 'refused') return REFUSED;
      if (!connection.endpoint) return WOULD_BLOCK;
      const target = bytes(at, length);
      const taken = connection.endpoint.tryRecv(target.length);
      if (taken === undefined) return WOULD_BLOCK;
      if (taken === null) return 0;
      target.set(taken);
      return taken.length;
    },
    close(id) {
      const connection = connections.get(id);
      connections.delete(id);
      connection?.endpoint?.close();
    },
  };

  return {
    imports,
    get port() {
      return port;
    },
    handle,
    attach(attached) {
      exports = attached;
    },
    started() {
      listening = false;
    },
    schedule,
    close,
  };
}
