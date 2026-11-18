/**
 * The seam between Python sockets and the runtime's virtual TCP. The transport
 * itself (connections to virtual ports, the Postgres wire gateway on 5432) is
 * the process host's; this module defines what Python needs from it, adapts
 * timeouts onto it, and installs the Python side (`bfwc/vsocket.py`).
 *
 * **How pg8000 reaches the database.** `pg8000.native.Connection(user,
 * host="localhost", port=5432, …)` calls `socket.create_connection((host,
 * port), timeout)`, then `makefile("rwb")`, and speaks the Postgres wire
 * protocol over it with blocking `read`/`write`/`flush`. After
 * `installVirtualSockets`, `create_connection` returns a `VirtualSocket`: each
 * `connect`/`send`/`recv` waits on a transport promise through
 * `pyodide.ffi.run_sync` — JSPI stack switching, no SharedArrayBuffer — so
 * pg8000 runs unmodified. `run_sync` needs JSPI in the engine (Chrome 137+,
 * Node 24+) and a Python stack entered through a promising call: the runtime
 * runs scripts with `runPythonAsync`, and ASGI/WSGI requests run as asyncio
 * tasks on Pyodide's event loop, which are promising too — both are asserted
 * by the runtime's tests (`can_run_sync()` inside a request handler). Where
 * JSPI is missing, blocking calls raise `BlockingIOError`; asyncio code uses
 * `bfwc.vsocket.open_connection(host, port)`, which awaits the same transport
 * and works everywhere.
 */
import type { PyodideLike } from './pyodideLoader.js';

/**
 * Virtual TCP as Python consumes it: connection ids, bytes in and out. Every
 * method may return a promise; Python waits on it (blocking through JSPI, or
 * awaiting from asyncio).
 */
export interface VirtualTcpTransport {
  /** Open a connection to `host:port` on the virtual network; rejects (ECONNREFUSED) when nothing listens there. */
  connect(host: string, port: number): Promise<number>;
  /**
   * Send bytes; resolves once the connection has room for more — while the
   * peer is far behind (dialTransport.ts: 64 KiB in flight) it waits, which is
   * Python's backpressure (`sendall` blocks, `drain` awaits).
   */
  send(connId: number, data: Uint8Array): Promise<void> | void;
  /** Up to `max` bytes as they arrive; `null` at end of stream. One `recv` at a time per connection. */
  recv(connId: number, max: number): Promise<Uint8Array | null>;
  /**
   * Half-close: no more bytes from this side, the peer reads end of stream.
   * Optional — the runtime's own connections have no half-close (a channel
   * closes both ways), so over them `shutdown(SHUT_WR)` only stops local sends
   * and the peer sees the end at `close()`.
   */
  shutdown?(connId: number): void;
  close(connId: number): void;
}

/** The JS module name the Python side imports the transport as. */
export const VIRTUAL_TCP_MODULE = '_bfwc_tcp';

/** What a timed-out `recv` answers (the Python side raises `socket.timeout` / `BlockingIOError`). */
const TIMEOUT = 'timeout';

const timer = (ms: number) => new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), ms));

/**
 * The transport as the Python module sees it: timeouts added (`undefined`/null
 * waits forever, 0 is a non-blocking poll), and a `recv` that timed out kept
 * for the next call, so no bytes are lost. End of stream is `undefined`:
 * Python sees JavaScript null as `jsnull`, undefined as None.
 */
export function pythonTcpModule(transport: VirtualTcpTransport) {
  const inFlight = new Map<number, Promise<Uint8Array | null>>();
  return {
    async connect(host: string, port: number, timeoutMs?: number | null) {
      const connecting = transport.connect(host, port);
      if (timeoutMs === undefined || timeoutMs === null) return connecting;
      const result = await Promise.race([connecting, timer(timeoutMs)]);
      if (result === TIMEOUT) {
        void connecting.then((connId) => transport.close(connId), () => undefined);
        throw new Error('timed out');
      }
      return result;
    },
    send: (connId: number, data: Uint8Array) => Promise.resolve(transport.send(connId, data.slice())),
    async recv(connId: number, max: number, timeoutMs?: number | null) {
      const receiving = inFlight.get(connId) ?? transport.recv(connId, max);
      inFlight.set(connId, receiving);
      const result = timeoutMs === undefined || timeoutMs === null ? await receiving : await Promise.race([receiving, timer(timeoutMs)]);
      if (result === TIMEOUT) return TIMEOUT;
      inFlight.delete(connId);
      return result ?? undefined;
    },
    shutdown: (connId: number) => transport.shutdown?.(connId),
    close(connId: number) {
      inFlight.delete(connId);
      transport.close(connId);
    },
  };
}

/** Make `transport` the network of Python's TCP sockets (`socket.socket`, `create_connection`, `bfwc.vsocket`). */
export function installVirtualSockets(pyodide: PyodideLike, transport: VirtualTcpTransport): void {
  pyodide.registerJsModule(VIRTUAL_TCP_MODULE, pythonTcpModule(transport));
  pyodide.runPython('import bfwc.vsocket\nbfwc.vsocket.install()');
}
