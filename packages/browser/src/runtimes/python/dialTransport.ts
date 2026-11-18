/**
 * Python's virtual TCP over the process protocol's dialled connections: a
 * {@link VirtualTcpTransport} on top of `dial` (`createWorkerConnections`, the
 * same worker-side relay Node's `net.connect` uses — `dial` / `dial-result` /
 * `dial-data` / `dial-ack` / `dial-close`). As with Node's `net`, only
 * localhost is reachable; the port alone picks the server, in any process.
 *
 * Flow control is the shared connection core's (runtimes/channelEndpoint.ts):
 * bytes are credited back only as Python reads them, and above
 * {@link SEND_HIGH_WATER_MARK} in flight a send waits, so Python's `sendall`
 * blocks (or its `drain` awaits) as it would on a full socket buffer. A close
 * wakes every waiter.
 *
 * The Python process Worker uses it by default (pythonWorkerProcess.ts).
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from '../../node/protocol.js';
import { createWorkerDialer } from '../../node/workerConnections.js';
import { ChannelEndpoint, SEND_HIGH_WATER_MARK } from '../channelEndpoint.js';
import type { VirtualTcpTransport } from './virtualSocket.js';

export { SEND_HIGH_WATER_MARK };

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

interface Waiters {
  /** A reader waiting for data or the end. */
  wakeReader?: () => void;
  /** Senders waiting for room. */
  wakeSenders: Array<() => void>;
}

type Connection = Waiters & { endpoint: ChannelEndpoint };

const wake = (waiters: Waiters) => {
  const reader = waiters.wakeReader;
  waiters.wakeReader = undefined;
  reader?.();
  for (const sender of waiters.wakeSenders.splice(0)) sender();
};

/** A transport over `dial(port)` (the client end of a connection, or undefined when nothing listens there). */
export function createChannelTransport(dial: (port: number) => Promise<ByteChannel | undefined>, highWaterMark = SEND_HIGH_WATER_MARK): VirtualTcpTransport {
  const connections = new Map<number, Connection>();
  let nextId = 1;
  const open = (connId: number) => {
    const connection = connections.get(connId);
    if (!connection) throw new Error(`Bad file descriptor: connection ${connId} is closed.`);
    return connection;
  };
  return {
    async connect(host, port) {
      // As for Node's net.connect: the virtual network is localhost only, never dialled out.
      if (!LOCAL_HOSTS.has(host.toLowerCase())) throw new Error(`connect ECONNREFUSED ${host}:${port} (only localhost is reachable in the browser runtime)`);
      const channel = await dial(port);
      if (!channel) throw new Error(`connect ECONNREFUSED ${host}:${port}`);
      const connId = nextId++;
      const waiters: Waiters = { wakeSenders: [] };
      const connection: Connection = Object.assign(waiters, { endpoint: new ChannelEndpoint(channel, () => wake(waiters), highWaterMark) });
      connections.set(connId, connection);
      return connId;
    },
    async send(connId, data) {
      const connection = open(connId);
      const { endpoint } = connection;
      if (endpoint.ended) throw new Error('Broken pipe: the connection is closed.');
      endpoint.send(data);
      while (!endpoint.writable && !endpoint.ended) await new Promise<void>((resolve) => connection.wakeSenders.push(resolve));
    },
    async recv(connId, max) {
      const connection = open(connId);
      for (;;) {
        const taken = connection.endpoint.tryRecv(max);
        if (taken !== undefined) return taken;
        await new Promise<void>((resolve) => (connection.wakeReader = resolve));
      }
    },
    close(connId) {
      const connection = connections.get(connId);
      if (!connection) return;
      // A recv or send still waiting ends now (end of stream / broken pipe), never strands.
      connection.endpoint.close();
      wake(connection);
      connections.delete(connId);
    },
  };
}

/**
 * The transport for a Python process Worker: dials go out through `post`, and
 * the Worker's message loop hands the page's dial messages to `receive`
 * (returns false for messages that are not about dialled connections).
 */
export function createDialTransport(post: (message: WorkerToHost) => void): { transport: VirtualTcpTransport; receive(message: HostToWorker): boolean } {
  const dialer = createWorkerDialer(post);
  return { transport: createChannelTransport((port) => dialer.dial(port)), receive: (message) => dialer.receive(message) };
}
