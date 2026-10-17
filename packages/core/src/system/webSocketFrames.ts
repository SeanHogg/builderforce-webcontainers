/**
 * The WebSocket wire format (RFC 6455): the opening handshake's accept key and
 * frame encoding/decoding. Runtime-agnostic, so the same codec drives the
 * client end in the host page (bridging a preview's `WebSocket`) and tests that
 * speak to a server's `upgrade` handler byte for byte.
 */
import { hashAlgorithm } from '../node/hashes.js';

export const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const Opcode = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export interface WebSocketFrame {
  fin: boolean;
  opcode: number;
  /** Unmasked. */
  payload: Uint8Array;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
export function webSocketAccept(key: string): string {
  return bytesToBase64(hashAlgorithm('sha1').digest(new TextEncoder().encode(key + WEBSOCKET_GUID)));
}

/** A fresh `Sec-WebSocket-Key` (16 random bytes, base64). */
export function webSocketKey(): string {
  return bytesToBase64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** One frame. Clients must mask (`mask: true` picks a random key); servers must not. */
export function encodeFrame(opcode: number, payload: Uint8Array, options: { mask?: boolean | Uint8Array; fin?: boolean } = {}): Uint8Array {
  const length = payload.byteLength;
  const maskKey = options.mask === true ? globalThis.crypto.getRandomValues(new Uint8Array(4)) : options.mask || undefined;
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const headerLength = 2 + extended + (maskKey ? 4 : 0);
  const frame = new Uint8Array(headerLength + length);
  const view = new DataView(frame.buffer);
  frame[0] = (options.fin === false ? 0 : 0x80) | (opcode & 0x0f);
  frame[1] = (maskKey ? 0x80 : 0) | (extended === 0 ? length : extended === 2 ? 126 : 127);
  if (extended === 2) view.setUint16(2, length);
  else if (extended === 8) {
    view.setUint32(2, Math.floor(length / 2 ** 32));
    view.setUint32(6, length >>> 0);
  }
  if (maskKey) {
    frame.set(maskKey, 2 + extended);
    for (let i = 0; i < length; i++) frame[headerLength + i] = payload[i]! ^ maskKey[i & 3]!;
  } else frame.set(payload, headerLength);
  return frame;
}

/** A close frame's payload: the status code and a UTF-8 reason. */
export function encodeClosePayload(code?: number, reason = ''): Uint8Array {
  if (code === undefined) return new Uint8Array();
  const text = new TextEncoder().encode(reason);
  const out = new Uint8Array(2 + text.byteLength);
  new DataView(out.buffer).setUint16(0, code);
  out.set(text, 2);
  return out;
}

/** Status 1005 ("no status received") when the payload is empty. */
export function decodeClosePayload(payload: Uint8Array): { code: number; reason: string } {
  if (payload.byteLength < 2) return { code: 1005, reason: '' };
  return { code: new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0), reason: new TextDecoder().decode(payload.subarray(2)) };
}

/** Splits a byte stream into frames, whatever the chunking. */
export class FrameDecoder {
  private buffer = new Uint8Array(0);

  push(bytes: Uint8Array): WebSocketFrame[] {
    if (bytes.byteLength) {
      const joined = new Uint8Array(this.buffer.byteLength + bytes.byteLength);
      joined.set(this.buffer);
      joined.set(bytes, this.buffer.byteLength);
      this.buffer = joined;
    }
    const frames: WebSocketFrame[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) return frames;
      frames.push(frame);
    }
  }

  private next(): WebSocketFrame | undefined {
    const b = this.buffer;
    if (b.byteLength < 2) return undefined;
    const masked = (b[1]! & 0x80) !== 0;
    let length = b[1]! & 0x7f;
    let offset = 2;
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (length === 126) {
      if (b.byteLength < 4) return undefined;
      length = view.getUint16(2);
      offset = 4;
    } else if (length === 127) {
      if (b.byteLength < 10) return undefined;
      length = view.getUint32(2) * 2 ** 32 + view.getUint32(6);
      offset = 10;
    }
    const maskKey = masked ? b.subarray(offset, offset + 4) : undefined;
    if (masked) offset += 4;
    if (b.byteLength < offset + length) return undefined;
    const payload = b.slice(offset, offset + length);
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ maskKey[i & 3]!;
    const frame = { fin: (b[0]! & 0x80) !== 0, opcode: b[0]! & 0x0f, payload };
    this.buffer = b.slice(offset + length);
    return frame;
  }
}
