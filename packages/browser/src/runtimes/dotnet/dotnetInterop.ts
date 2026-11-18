/**
 * The Worker's side of the host program's boundary (dotnet-host/Interop.cs):
 * the functions .NET imports (module `bfwc`) and how they meet the process
 * protocol.
 *
 * - Serving: the in-memory server claims a port (`listen`, refused when another
 *   process holds it; the page hears `listen`); each `http-request` to it goes
 *   to `Exports.Request`, and the response streams back — `respondHead`
 *   resolves the handler with the head and a body stream, `respondChunk`s fill
 *   it, `respondEnd` closes it. A client hanging up cancels the request.
 * - Dialling: `dial` opens a connection to a virtual port anywhere in the
 *   runtime (the Postgres gateway, another service) through the process
 *   protocol's dialled connections; bytes flow both ways as copies. A server
 *   that speaks first may deliver bytes before .NET has registered the
 *   connection id `dial` returned: the host program holds them until it does
 *   (dotnet-host/VirtualTcp.cs).
 */
import type { ByteChannel, HttpHandler, HttpResponseHead, HttpStreamResponse } from '@seanhogg/builderforce-webcontainers-core';
import type { WorkerToHost } from '../../node/protocol.js';
import type { DotnetExports, DotnetImports } from './dotnetLoader.js';

/** Dial a virtual port: the client end, or undefined when nothing listens there. */
export type Dial = (port: number) => Promise<ByteChannel | undefined>;

export interface DotnetBridge {
  readonly imports: DotnetImports;
  /** Ports this process serves. */
  readonly listening: ReadonlySet<number>;
  /** The handler for a port this process serves (node/servedPorts.ts `handlerFor`). */
  handlerFor(port: number): HttpHandler | undefined;
  /** The host program's exports, once the runtime is up. */
  attach(exports: DotnetExports): void;
  /** Ask the program's hosts to stop (a kill): `Exports.Stop`. */
  stop(): void;
  /** Fail every response still pending and hang up every connection (the process is ending). */
  closeAll(): void;
}

export interface DotnetBridgeOptions {
  post(message: WorkerToHost): void;
  dial: Dial;
  /** Ports taken anywhere in the runtime (node/servedPorts.ts `taken`). */
  taken: Set<number>;
  stdout(text: string): void;
  stderr(text: string): void;
}

interface Pending {
  resolve(response: HttpStreamResponse): void;
  reject(error: Error): void;
  body?: ReadableStreamDefaultController<Uint8Array>;
}

function headersOf(json: string): HttpResponseHead['headers'] {
  const headers: HttpResponseHead['headers'] = {};
  for (const [name, values] of Object.entries(JSON.parse(json) as Record<string, string[]>)) {
    headers[name.toLowerCase()] = values.length === 1 ? values[0]! : values;
  }
  return headers;
}

export function createDotnetBridge(options: DotnetBridgeOptions): DotnetBridge {
  let exports: DotnetExports | undefined;
  const listening = new Set<number>();
  const pending = new Map<number, Pending>();
  const connections = new Map<number, ByteChannel>();
  let nextRequest = 1;
  let nextConnection = 1;

  const handler =
    (port: number): HttpHandler =>
    (request) =>
      new Promise<HttpStreamResponse>((resolve, reject) => {
        if (!exports) return reject(new Error('The .NET runtime is not running.'));
        const reqId = nextRequest++;
        pending.set(reqId, { resolve, reject });
        exports.Request(reqId, port, request.method, request.url, JSON.stringify(request.headers), request.body ?? new Uint8Array(0));
      });

  const imports: DotnetImports = {
    stdout: (text) => options.stdout(text),
    stderr: (text) => options.stderr(text),
    listen(port) {
      if (options.taken.has(port) && !listening.has(port)) return false;
      options.taken.add(port);
      listening.add(port);
      options.post({ type: 'listen', port });
      return true;
    },
    unlisten(port) {
      if (!listening.delete(port)) return;
      options.taken.delete(port);
      options.post({ type: 'unlisten', port });
    },
    respondHead(reqId, status, headersJson) {
      const entry = pending.get(reqId);
      if (!entry) return;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          entry.body = controller;
        },
        cancel: () => {
          pending.delete(reqId);
          exports?.CancelRequest(reqId);
        },
      });
      entry.resolve({ status, headers: headersOf(headersJson), body });
    },
    respondChunk(reqId, data) {
      pending.get(reqId)?.body?.enqueue(data.slice());
    },
    respondEnd(reqId, error) {
      const entry = pending.get(reqId);
      pending.delete(reqId);
      if (!entry) return;
      if (!entry.body) return entry.reject(new Error(error ?? 'The response ended before its head.'));
      if (error) entry.body.error(new Error(error));
      else entry.body.close();
    },
    async dial(port) {
      const channel = await options.dial(port);
      if (!channel) return -1;
      const connId = nextConnection++;
      connections.set(connId, channel);
      // Only while the connection is open: .NET holds bytes for an id it has not registered yet, never for one it hung up.
      channel.onData((data) => connections.has(connId) && exports?.TcpData(connId, data));
      channel.onClose(() => {
        if (connections.delete(connId)) exports?.TcpClosed(connId);
      });
      return connId;
    },
    send(connId, data) {
      connections.get(connId)?.send(data.slice());
    },
    hangUp(connId) {
      const channel = connections.get(connId);
      connections.delete(connId);
      channel?.close();
    },
  };

  return {
    imports,
    listening,
    handlerFor: (port) => (listening.has(port) ? handler(port) : undefined),
    attach(attached) {
      exports = attached;
    },
    stop() {
      exports?.Stop();
    },
    closeAll() {
      for (const entry of pending.values()) {
        if (entry.body) entry.body.error(new Error('The process exited.'));
        else entry.reject(new Error('The process exited.'));
      }
      pending.clear();
      for (const channel of connections.values()) channel.close();
      connections.clear();
    },
  };
}
