/**
 * One dialled connection's client end, read and written without ever
 * waiting — the synchronous core under Python's virtual sockets
 * (python/dialTransport.ts, which turns "not yet" into awaits) and the Rust
 * runtime's bridge (rust/rustBridge.ts, which turns it into "would block").
 *
 * Flow control both ways, credit-based like every byte channel here:
 * - reading: the channel is under manual flow control, and bytes are credited
 *   back (`consumed`) only as they are taken, so a fast sender is held back;
 * - writing: bytes sent but not yet consumed by the far reader are counted
 *   (`onConsumed` credits them back); above the high-water mark the end is not
 *   `writable` until the reader catches up.
 *
 * `onChange` fires on everything a waiter may care about: bytes arriving,
 * room to write again, the far end hanging up.
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';

/** Bytes a connection may have in flight (sent, not yet read by the peer) before it stops being writable. */
export const SEND_HIGH_WATER_MARK = 64 * 1024;

export class ChannelEndpoint {
  private readonly queue: Uint8Array[] = [];
  /** Sent bytes the peer has not consumed yet. */
  private unacked = 0;
  /** The far end hung up, or this end closed. */
  ended = false;

  constructor(
    private readonly channel: ByteChannel,
    onChange: () => void,
    private readonly highWaterMark = SEND_HIGH_WATER_MARK,
  ) {
    channel.manualFlowControl();
    channel.onData((data) => {
      this.queue.push(data);
      onChange();
    });
    channel.onConsumed((bytes) => {
      this.unacked = Math.max(0, this.unacked - bytes);
      if (this.unacked <= this.highWaterMark) onChange();
    });
    channel.onClose(() => {
      this.ended = true;
      onChange();
    });
  }

  /** Whether a send now stays within the high-water mark. */
  get writable(): boolean {
    return this.unacked <= this.highWaterMark;
  }

  /** Up to `max` bytes (credited back to the sender); `null` at the end; `undefined` when nothing has arrived yet. */
  tryRecv(max: number): Uint8Array | null | undefined {
    const chunk = this.queue.shift();
    if (!chunk) return this.ended ? null : undefined;
    const taken = chunk.byteLength > max ? chunk.subarray(0, max) : chunk;
    if (taken !== chunk) this.queue.unshift(chunk.subarray(max));
    if (!this.channel.closed) this.channel.consumed(taken.byteLength);
    return taken;
  }

  /** Send now (a caller that respects `writable` waits first). */
  send(data: Uint8Array): void {
    this.channel.send(data);
    this.unacked += data.byteLength;
  }

  /** Hang up: what is unread is dropped, and every later read is the end. */
  close(): void {
    this.ended = true;
    this.queue.length = 0;
    this.channel.close();
  }
}
