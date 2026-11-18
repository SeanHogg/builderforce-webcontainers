/**
 * The `http` and `https` module objects. `https.createServer` is the same
 * virtual server (TLS is the preview origin's job). `net` is `../net/`.
 */
import { EventEmitterBase } from '../events.js';
import { ClientRequest, createFetch, type ClientDeps } from './client.js';
import { IncomingMessage, OutgoingHeaders, Server, ServerResponse } from './server.js';
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

