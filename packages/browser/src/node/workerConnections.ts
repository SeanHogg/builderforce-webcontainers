/**
 * The worker side of a process's connections (the page side is
 * connectionRelay.ts): each connection is a local byte pipe whose far end is
 * relayed to the page as messages — bytes, flow-control credits and hang-ups
 * (relayedChannels.ts).
 *
 * - inbound: the page opened a connection to one of this process's servers —
 *   upgraded (`socket-open`, handed to the server's `upgrade` handler) or raw
 *   TCP (`socket-accept`, handed to its `net.Server`).
 * - outbound: this process dials a port (`net.connect`) the page routes to
 *   whatever listens there, in any process.
 */
import { acceptConnection, createChannelPair, type ByteChannel, type ConnectionHandler, type HttpRequestData, type UpgradeHandler } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { RelayedChannels } from './relayedChannels.js';

type ConnectionMessage = Extract<HostToWorker, { type: 'socket-data' | 'socket-ack' | 'socket-close' | 'dial-result' | 'dial-data' | 'dial-ack' | 'dial-close' }>;

const CONNECTION_MESSAGES = new Set<string>(['socket-data', 'socket-ack', 'socket-close', 'dial-result', 'dial-data', 'dial-ack', 'dial-close']);

export function isWorkerConnectionMessage(message: HostToWorker): message is ConnectionMessage {
  return CONNECTION_MESSAGES.has(message.type);
}

export interface WorkerConnections {
  /** The page opened an upgraded connection (a WebSocket) to a server here; no handler hangs up. */
  upgraded(connId: number, request: HttpRequestData, upgrade: UpgradeHandler | undefined): void;
  /**
   * The page opened a raw TCP connection to a port here. `server` is what listens
   * on it now (its `accept`: a `net.Server`; none: an HTTP-only server); nothing
   * listening any more hangs up.
   */
  accepted(connId: number, server: { accept?: ConnectionHandler } | undefined): void;
  /** Dial `port` anywhere in the runtime: the client end, or undefined when nothing listens. */
  dial(port: number): Promise<ByteChannel | undefined>;
  receive(message: ConnectionMessage): void;
}

export function createWorkerConnections(post: (message: WorkerToHost) => void): WorkerConnections {
  /** Our ends of connections to this process's servers, by the page's id. */
  const inbound = new RelayedChannels('socket', post);
  /** Our ends of connections this process dialled, by our id. */
  const outbound = new RelayedChannels('dial', post);
  const dialling = new Map<number, (ok: boolean) => void>();
  let nextDial = 1;

  return {
    upgraded(connId, request, upgrade) {
      if (!upgrade) return post({ type: 'socket-close', connId });
      const [ours, server] = createChannelPair();
      inbound.add(connId, ours);
      upgrade(request, server);
    },
    accepted(connId, server) {
      if (!server) return post({ type: 'socket-close', connId });
      inbound.add(connId, acceptConnection(server.accept));
    },
    dial(port) {
      const connId = nextDial++;
      post({ type: 'dial', connId, port });
      return new Promise((resolve) => {
        dialling.set(connId, (ok) => {
          if (!ok) return resolve(undefined);
          const [ours, client] = createChannelPair();
          outbound.add(connId, ours);
          resolve(client);
        });
      });
    },
    receive(message) {
      if (message.type === 'dial-result') {
        const settle = dialling.get(message.connId);
        dialling.delete(message.connId);
        return settle?.(message.ok);
      }
      if (inbound.owns(message)) return inbound.receive(message);
      if (outbound.owns(message)) return outbound.receive(message);
    },
  };
}
