/**
 * The `http`, `https` and `net` module objects. `https.createServer` is the
 * same virtual server (TLS is the preview origin's job); `net` offers just
 * enough — `isIP*` and a port-reserving `createServer` — for the port-probing
 * helpers (get-port, detect-port) dev tools run before listening.
 */
import { EventEmitterBase } from '../events.js';
import { ClientRequest, createFetch, type ClientDeps } from './client.js';
import { FakeSocket, IncomingMessage, OutgoingHeaders, Server, ServerResponse } from './server.js';
import { METHODS, STATUS_CODES } from './status.js';

export { createFetch };

class Agent extends EventEmitterBase {
  maxSockets = Infinity;
  maxFreeSockets = 256;
  sockets = {};
  requests = {};
  freeSockets = {};
  constructor(readonly options: Record<string, unknown> = {}) {
    super();
  }
  destroy(): void {}
}

export function createHttpModule(deps: ClientDeps, protocol: 'http:' | 'https:'): Record<string, unknown> {
  const request = (input: unknown, extra?: unknown, callback?: (res: IncomingMessage) => void) => new ClientRequest(deps, input, extra, callback, protocol);
  const get = (input: unknown, extra?: unknown, callback?: (res: IncomingMessage) => void) => {
    const req = request(input, extra, callback);
    req.end();
    return req;
  };
  const globalAgent = new Agent();
  return {
    createServer: (options?: unknown, listener?: (req: IncomingMessage, res: ServerResponse) => void) => new Server(deps, options, listener),
    request,
    get,
    Server: class extends Server {
      constructor(options?: unknown, listener?: (req: IncomingMessage, res: ServerResponse) => void) {
        super(deps, options, listener);
      }
    },
    IncomingMessage,
    ServerResponse,
    OutgoingMessage: OutgoingHeaders,
    ClientRequest,
    Agent,
    globalAgent,
    STATUS_CODES,
    METHODS,
    maxHeaderSize: 16384,
    validateHeaderName(name: string) {
      if (!/^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/.test(name)) throw Object.assign(new TypeError(`Header name must be a valid HTTP token ["${name}"]`), { code: 'ERR_INVALID_HTTP_TOKEN' });
    },
    validateHeaderValue(name: string, value: unknown) {
      if (value === undefined) throw Object.assign(new TypeError(`Invalid value "undefined" for header "${name}"`), { code: 'ERR_HTTP_INVALID_HEADER_VALUE' });
    },
    setMaxIdleHTTPParsers: () => undefined,
  };
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;

export function createNetModule(deps: ClientDeps): Record<string, unknown> {
  /** A TCP server cannot exist here; one that only RESERVES its port keeps port probes truthful. */
  class NetServer extends EventEmitterBase {
    private reservation?: { port: number; close(): void };
    private release?: () => void;
    listening = false;
    listen(...args: unknown[]): this {
      const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as () => void) : undefined;
      const first = args[0];
      const port = typeof first === 'object' && first ? Number((first as { port?: number }).port ?? 0) : Number(first ?? 0);
      if (callback) this.once('listening', callback);
      try {
        this.reservation = deps.system.listen(port, async () => ({ status: 502, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('Not an HTTP server') }));
      } catch (error) {
        queueMicrotask(() => this.emit('error', error));
        return this;
      }
      this.listening = true;
      this.release = deps.loop.hold();
      queueMicrotask(() => this.emit('listening'));
      return this;
    }
    address() {
      return this.reservation ? { address: '::', family: 'IPv6', port: this.reservation.port } : null;
    }
    close(callback?: () => void): this {
      this.reservation?.close();
      this.reservation = undefined;
      this.listening = false;
      this.release?.();
      if (callback) this.once('close', callback);
      queueMicrotask(() => this.emit('close'));
      return this;
    }
    ref(): this { return this; }
    unref(): this {
      this.release?.();
      this.release = undefined;
      return this;
    }
  }
  const noTcp = () => {
    throw Object.assign(new Error('Raw TCP sockets are not available in the browser runtime'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
  };
  return {
    createServer: () => new NetServer(),
    Server: NetServer,
    Socket: FakeSocket,
    Stream: FakeSocket,
    connect: noTcp,
    createConnection: noTcp,
    isIP: (s: string) => (IPV4.test(s) ? 4 : IPV6.test(s) ? 6 : 0),
    isIPv4: (s: string) => IPV4.test(s),
    isIPv6: (s: string) => IPV6.test(s),
    getDefaultAutoSelectFamily: () => true,
    setDefaultAutoSelectFamily: () => undefined,
  };
}
