import { describe, expect, it } from 'vitest';
import { FrameDecoder, Opcode, decodeClosePayload, encodeClosePayload, encodeFrame, webSocketAccept, webSocketKey, type WebSocketFrame } from '../../src/system/webSocketFrames.js';
import { createChannelPair, pushStream, readBody } from '../../src/system/httpStream.js';

describe('websocket frames', () => {
  it('computes the RFC 6455 accept key', () => {
    expect(webSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(atob(webSocketKey())).toHaveLength(16);
  });

  it('encodes the RFC example frames byte for byte', () => {
    const hello = new TextEncoder().encode('Hello');
    expect(Array.from(encodeFrame(Opcode.text, hello))).toEqual([0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f]);
    expect(Array.from(encodeFrame(Opcode.text, hello, { mask: new Uint8Array([0x37, 0xfa, 0x21, 0x3d]) }))).toEqual([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]);
  });

  it('round-trips short, 16-bit and 64-bit lengths, masked or not, however the bytes are split', () => {
    const sizes = [0, 125, 126, 65535, 65536];
    const frames = sizes.map((n, i) => encodeFrame(Opcode.binary, new Uint8Array(n).fill(i + 1), { mask: i % 2 === 0 }));
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      all.set(f, offset);
      offset += f.length;
    }
    const decoder = new FrameDecoder();
    const decoded: WebSocketFrame[] = [];
    for (let i = 0; i < all.length; i += 1000) decoded.push(...decoder.push(all.subarray(i, i + 1000)));
    expect(decoded.map((f) => [f.fin, f.opcode, f.payload.length, f.payload[0] ?? 0])).toEqual(sizes.map((n, i) => [true, Opcode.binary, n, n ? i + 1 : 0]));
  });

  it('carries close codes and reasons', () => {
    expect(decodeClosePayload(encodeClosePayload(4001, 'gone away'))).toEqual({ code: 4001, reason: 'gone away' });
    expect(decodeClosePayload(new Uint8Array())).toEqual({ code: 1005, reason: '' });
  });
});

describe('stream plumbing', () => {
  it('feeds a body stream from pushes and reports a cancel', async () => {
    let cancelled = false;
    const body = pushStream(() => (cancelled = true));
    body.push(new Uint8Array([1]));
    body.push(new Uint8Array([2, 3]));
    body.end();
    body.push(new Uint8Array([4])); // ignored after the end
    expect(Array.from(await readBody(body.stream))).toEqual([1, 2, 3]);
    expect(cancelled).toBe(false);
    const open = pushStream(() => (cancelled = true));
    await open.stream.cancel();
    expect(cancelled).toBe(true);
  });

  it('pairs channel ends: data in order, then the close', async () => {
    const [a, b] = createChannelPair();
    const events: string[] = [];
    b.onData((data) => events.push(`data ${Array.from(data)}`));
    b.onClose(() => events.push('close'));
    a.send(new Uint8Array([1, 2]));
    a.send(new Uint8Array([3]));
    a.close();
    a.send(new Uint8Array([9])); // after close: dropped
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['data 1,2', 'data 3', 'close']);
    expect(b.closed).toBe(true);
  });
});
