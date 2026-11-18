/**
 * Python's virtual TCP over the process protocol's dialled connections: a
 * {@link VirtualTcpTransport} on top of `dial` (`createWorkerConnections`, the
 * same worker-side relay Node's `net.connect` uses — `dial` / `dial-result` /
 * `dial-data` / `dial-ack` / `dial-close`). As with Node's `net`, only
 * localhost is reachable; the port alone picks the server, in any process.
 *
 * Flow control both ways, credit-based like every byte channel here:
 * - reading: the channel is under manual flow control, and bytes are credited
 *   back (`consumed`) only as Python reads them, so a fast sender is held back;
 * - writing: bytes sent but not yet consumed by the far reader are counted
 *   (`onConsumed` credits them back); above {@link SEND_HIGH_WATER_MARK} a send
 *   waits, so Python's `sendall` blocks (or its `drain` awaits) as it would on
 *   a full socket buffer. A close wakes every waiter.
 *
 * The Python process Worker uses it by default (pythonWorkerProcess.ts).
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from '../../node/protocol.js';
import { createWorkerConnections, isWorkerConnectionMessage } from '../../node/workerConnections.js';
import type { VirtualTcpTransport } from './virtualSocket.js';

/** Bytes a connection may have in flight (sent, not yet read by the peer) before a send waits. */
export const SEND_HIGH_WATER_MARK = 64 * 1024;

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

interface Connection {
  channel: ByteChannel;
  queue: Uint8Array[];
  ended: boolean;
  /** Sent bytes the peer has not consumed yet. */
  unacked: number;
  /** A reader waiting for data or the end. */
  wakeReader?: () => void;
  /** Senders waiting for room. */
  wakeSenders: Array<() => void>;
}

const wake = (connection: Connection) => {
  const reader = connection.wakeReader;
  connection.wakeReader = undefined;
  reader?.();
  for (const sender of connection.wakeSenders.splice(0)) sender();
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
      channel.manualFlowControl();
      const connId = nextId++;
      const connection: Connection = { channel, queue: [], ended: false, unacked: 0, wakeSenders: [] };
      channel.onData((data) => {
        connection.queue.push(data);
        wake(connection);
      });
      channel.onConsumed((bytes) => {
        connection.unacked = Math.max(0, connection.unacked - bytes);
        if (connection.unacked <= highWaterMark) wake(connection);
      });
      channel.onClose(() => {
        connection.ended = true;
        wake(connection);
      });
      connections.set(connId, connection);
      return connId;
    },
    async send(connId, data) {
      const connection = open(connId);
      if (connection.ended) throw new Error('Broken pipe: the connection is closed.');
      connection.channel.send(data);
      connection.unacked += data.byteLength;
      while (connection.unacked > highWaterMark && !connection.ended) await new Promise<void>((resolve) => connection.wakeSenders.push(resolve));
    },
    async recv(connId, max) {
      const connection = open(connId);
      while (!connection.queue.length && !connection.ended) await new Promise<void>((resolve) => (connection.wakeReader = resolve));
      const chunk = connection.queue.shift();
      if (!chunk) return null;
      const taken = chunk.byteLength > max ? chunk.subarray(0, max) : chunk;
      if (taken !== chunk) connection.queue.unshift(chunk.subarray(max));
      if (!connection.channel.closed) connection.channel.consumed(taken.byteLength);
      return taken;
    },
    close(connId) {
      const connection = connections.get(connId);
      if (!connection) return;
      // A recv or send still waiting ends now (end of stream / broken pipe), never strands.
      connection.ended = true;
      connection.queue.length = 0;
      wake(connection);
      connection.channel.close();
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
  const connections = createWorkerConnections(post);
  return {
    transport: createChannelTransport((port) => connections.dial(port)),
    receive(message) {
      if (!isWorkerConnectionMessage(message) || !message.type.startsWith('dial')) return false;
      connections.receive(message);
      return true;
    },
  };
}
