/**
 * Splitting a client's byte stream into Postgres protocol packets. Before
 * start-up, packets are untyped (`int32 length, int32 code, …`); after the v3
 * start-up message, typed (`byte type, int32 length, …`). Lengths include
 * themselves.
 *
 * Bounded like Postgres's own reader: a start-up packet over
 * {@link MAX_STARTUP_PACKET} bytes, a message over {@link MAX_MESSAGE}, or a
 * length under 4 is a protocol violation (an `error` packet; the connection
 * should end). Chunks are kept as a list and each complete frame is copied out
 * once, so a large message arriving in many chunks costs linear time.
 */
import { PROTOCOL_V3 } from './pgMessages.js';

/** Postgres refuses start-up packets longer than this (`MAX_STARTUP_PACKET_LENGTH`). */
export const MAX_STARTUP_PACKET = 10_000;
/** Postgres's limit on one message (`PQ_LARGE_MESSAGE_LIMIT`, 1 GB minus one). */
export const MAX_MESSAGE = 0x3fffffff;

export type FrontendPacket =
  /** An untyped start-up packet: `code` is the protocol version, or an SSL/GSS/cancel request. */
  | { kind: 'startup'; code: number; params: Record<string, string> }
  /** A typed message, whole (type byte and length included), ready to pass to the engine. */
  | { kind: 'message'; type: number; bytes: Uint8Array }
  /** The stream broke the protocol; nothing after it can be framed. */
  | { kind: 'error'; message: string };

const decoder = new TextDecoder();

export class FrameReader {
  started = false;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private broken = false;

  push(data: Uint8Array): FrontendPacket[] {
    if (this.broken) return [];
    if (data.length) {
      this.chunks.push(data);
      this.buffered += data.length;
    }
    const packets: FrontendPacket[] = [];
    for (;;) {
      const header = this.started ? 5 : 4;
      if (this.buffered < header) break;
      const head = this.peek(header);
      const length = new DataView(head.buffer, head.byteOffset).getInt32(header - 4);
      const limit = this.started ? MAX_MESSAGE : MAX_STARTUP_PACKET;
      if (length < 4 || length > limit) {
        this.broken = true;
        this.chunks = [];
        this.buffered = 0;
        packets.push({ kind: 'error', message: length < 4 ? `Invalid message length ${length}.` : `${this.started ? 'Message' : 'Start-up packet'} of ${length} bytes exceeds the limit.` });
        break;
      }
      const total = length + header - 4;
      if (this.buffered < total) break;
      const bytes = this.take(total);
      if (this.started) packets.push({ kind: 'message', type: bytes[0]!, bytes });
      else {
        const packet = startupPacket(bytes);
        packets.push(packet);
        // A v3 start-up message ends the untyped phase; SSL/GSS requests do not.
        if (packet.code === PROTOCOL_V3) this.started = true;
      }
    }
    return packets;
  }

  /** The first `n` buffered bytes, without consuming them. */
  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    return this.copy(n, false);
  }

  /** Remove and return the first `n` buffered bytes (one copy). */
  private take(n: number): Uint8Array {
    this.buffered -= n;
    return this.copy(n, true);
  }

  private copy(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    let index = 0;
    while (at < n) {
      const chunk = this.chunks[index]!;
      const part = Math.min(chunk.length, n - at);
      out.set(chunk.subarray(0, part), at);
      at += part;
      if (!consume) index++;
      else if (part === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(part);
    }
    return out;
  }
}

function startupPacket(bytes: Uint8Array): Extract<FrontendPacket, { kind: 'startup' }> {
  const code = new DataView(bytes.buffer, bytes.byteOffset).getInt32(4);
  const params: Record<string, string> = {};
  if (code === PROTOCOL_V3) {
    const fields = decoder.decode(bytes.subarray(8)).split('\0');
    for (let i = 0; i + 1 < fields.length && fields[i]; i += 2) params[fields[i]!] = fields[i + 1]!;
  }
  return { kind: 'startup', code, params };
}
