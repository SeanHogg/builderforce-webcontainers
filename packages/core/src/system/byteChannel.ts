/**
 * The in-memory byte pipe connections run over: an upgraded HTTP connection
 * (a WebSocket) and a raw TCP connection (`net.connect`) alike. Two connected
 * ends; bytes sent on one arrive, asynchronously and in order, on the other.
 *
 * Flow control is credit-based: a writer hears (`onConsumed`) how much of what
 * it sent the reader has consumed, so it can bound what it has in flight
 * (`net.Socket`'s `write()` returning false until `'drain'`). By default an end
 * credits what it receives as soon as it is delivered, so a reader that knows
 * nothing about flow control never stalls a writer. A reader that wants to
 * push back calls `manualFlowControl()` and then credits with `consumed` as it
 * really consumes — `net.Socket`, the database gateway, and every relay (which
 * forwards the far reader's credits) do. Relays that carry an end across a
 * process boundary forward both the bytes and the credits.
 */
import type { ByteChannel, ConnectionHandler } from './types.js';

class ChannelEnd implements ByteChannel {
  peer!: ChannelEnd;
  closed = false;
  /** This end's reader credits explicitly (`consumed`); otherwise deliveries are credited at once. */
  private manual = false;
  private readonly data = new Set<(data: Uint8Array) => void>();
  private readonly closes = new Set<() => void>();
  private readonly credits = new Set<(bytes: number) => void>();

  send(data: Uint8Array): void {
    if (this.closed) return;
    const copy = new Uint8Array(data); // a copy (a Buffer's slice would be a view)
    queueMicrotask(() => {
      const peer = this.peer;
      if (peer.closed) return;
      for (const listener of peer.data) listener(copy);
      if (!peer.manual) peer.consumed(copy.byteLength);
    });
  }

  manualFlowControl(): void {
    this.manual = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Delivered after any data already sent, like a FIN after the last segment.
    queueMicrotask(() => {
      if (this.peer.closed) return; // both hung up at once: neither needs telling
      this.peer.closed = true;
      for (const listener of this.peer.closes) listener();
    });
  }

  consumed(bytes: number): void {
    if (this.closed || bytes <= 0) return;
    queueMicrotask(() => {
      for (const listener of this.peer.credits) listener(bytes);
    });
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  onConsumed(listener: (bytes: number) => void): () => void {
    this.credits.add(listener);
    return () => this.credits.delete(listener);
  }
}

/** Two connected ends: bytes sent on one arrive (asynchronously, in order) on the other. */
export function createChannelPair(): [ByteChannel, ByteChannel] {
  const a = new ChannelEnd();
  const b = new ChannelEnd();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * A server end for a port that serves HTTP but takes no raw connections: the
 * connection opens (port probes such as `wait-on tcp:` see the port as open),
 * and is closed as soon as the client sends anything — HTTP over a raw
 * connection is not bridged to the port's HTTP handler.
 */
function closeOnData(server: ByteChannel): void {
  server.onData(() => server.close());
}

/** Open a connection to a listener: hands it the server end (or the HTTP-only stand-in), returns the client end. */
export function acceptConnection(accept: ConnectionHandler | undefined): ByteChannel {
  const [client, server] = createChannelPair();
  (accept ?? closeOnData)(server);
  return client;
}
