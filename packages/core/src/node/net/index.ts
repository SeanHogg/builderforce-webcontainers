/**
 * The `net` module: virtual TCP between the processes of one runtime.
 * `createServer().listen(port)` takes connections; `createConnection`/`connect`
 * and `new Socket().connect()` dial a listener on localhost in any process.
 * Other hosts are refused (never the network); Unix socket paths too.
 */
import { NetServer } from './server.js';
import { NetSocket, type NetDeps } from './socket.js';

export { NetSocket, SEND_WINDOW, LOOPBACK_HOSTS } from './socket.js';
export { NetServer } from './server.js';

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}$/i;

export function createNetModule(deps: NetDeps): Record<string, unknown> {
  class Socket extends NetSocket {
    constructor(options?: { allowHalfOpen?: boolean }) {
      super(deps, options);
    }
  }
  class Server extends NetServer {
    constructor(options?: unknown, listener?: (socket: NetSocket) => void) {
      super(deps, () => new Socket(), options, listener);
    }
  }
  const connect = (...args: unknown[]) => {
    const options = args[0] && typeof args[0] === 'object' ? (args[0] as { allowHalfOpen?: boolean }) : {};
    return new Socket(options).connect(...args);
  };
  return {
    createServer: (options?: unknown, listener?: (socket: NetSocket) => void) => new Server(options, listener),
    Server,
    Socket,
    Stream: Socket,
    connect,
    createConnection: connect,
    isIP: (s: string) => (IPV4.test(s) ? 4 : IPV6.test(s) ? 6 : 0),
    isIPv4: (s: string) => IPV4.test(s),
    isIPv6: (s: string) => IPV6.test(s),
    getDefaultAutoSelectFamily: () => true,
    setDefaultAutoSelectFamily: () => undefined,
  };
}
