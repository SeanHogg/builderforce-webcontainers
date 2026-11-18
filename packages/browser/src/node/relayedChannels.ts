/**
 * The one relay for byte connections that cross a postMessage boundary: a table
 * of local channel ends, each forwarded to the other side under an id as
 * `<kind>-data` / `<kind>-ack` / `<kind>-close` messages, and the same three
 * messages from the other side applied to the end they name. Used for every hop:
 * a process's server connections (`socket-*`) and dialled ones (`dial-*`), page
 * and worker side, and database client connections (`db-conn-*`), page and
 * database Worker side.
 *
 * The local end is put under manual flow control: it credits only when the far
 * reader's `-ack` arrives, so backpressure reaches across the hop.
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';

export type RelayMessage<K extends string> =
  | { type: `${K}-data`; connId: number; data: Uint8Array }
  | { type: `${K}-ack`; connId: number; bytes: number }
  | { type: `${K}-close`; connId: number };

export class RelayedChannels<K extends string> {
  private readonly ends = new Map<number, ByteChannel>();

  constructor(
    private readonly kind: K,
    private readonly post: (message: RelayMessage<K>) => void,
  ) {}

  /** Is `message` one of this table's three? */
  owns(message: { type: string }): message is RelayMessage<K> {
    return message.type === `${this.kind}-data` || message.type === `${this.kind}-ack` || message.type === `${this.kind}-close`;
  }

  get size(): number {
    return this.ends.size;
  }

  /** Relay `end` under `connId`: what it hears goes to the other side. */
  add(connId: number, end: ByteChannel): void {
    const { kind } = this;
    this.ends.set(connId, end);
    end.manualFlowControl();
    end.onData((data) => this.post({ type: `${kind}-data`, connId, data }));
    end.onConsumed((bytes) => this.post({ type: `${kind}-ack`, connId, bytes }));
    end.onClose(() => {
      if (this.ends.delete(connId)) this.post({ type: `${kind}-close`, connId });
    });
  }

  /** Apply a message from the other side. */
  receive(message: RelayMessage<K>): void {
    const end = this.ends.get(message.connId);
    if (message.type === `${this.kind}-data`) end?.send((message as { data: Uint8Array }).data);
    else if (message.type === `${this.kind}-ack`) end?.consumed((message as { bytes: number }).bytes);
    else this.hangUp(message.connId);
  }

  /** Close one end without telling the other side (it asked, or already knows). */
  hangUp(connId: number): void {
    const end = this.ends.get(connId);
    this.ends.delete(connId);
    end?.close();
  }

  /** Close every end; with `tell`, the other side hears a `-close` for each. */
  closeAll(tell = false): void {
    const ids = [...this.ends.keys()];
    for (const connId of ids) {
      this.hangUp(connId);
      if (tell) this.post({ type: `${this.kind}-close`, connId });
    }
  }
}
