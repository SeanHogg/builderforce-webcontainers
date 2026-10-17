/**
 * The client end of a WebSocket to a virtual server, over an upgraded
 * {@link ByteChannel}: sends the opening handshake as an HTTP request, checks
 * the server's `101` reply (whatever wrote it — `ws`, socket.io's engine, a
 * hand-written `upgrade` handler), then speaks RFC 6455 frames. The host page
 * uses it to carry a preview's `new WebSocket('ws://localhost:3000')`.
 */
import type { ByteChannel, HttpRequestData } from './types.js';
import { FrameDecoder, Opcode, decodeClosePayload, encodeClosePayload, encodeFrame, webSocketAccept, webSocketKey } from './webSocketFrames.js';

export interface WebSocketCloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
}

export interface WebSocketConnection {
  /** 0 connecting, 1 open, 2 closing, 3 closed — `WebSocket.readyState`'s values. */
  readonly readyState: number;
  onOpen(listener: (info: { protocol: string }) => void): () => void;
  onMessage(listener: (data: string | Uint8Array) => void): () => void;
  /** Fires once; `wasClean` false and code 1006 when the connection dropped or the handshake failed. */
  onClose(listener: (info: WebSocketCloseInfo) => void): () => void;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketConnectOptions {
  /** Path and query on the server (`/socket?room=1`). */
  path: string;
  protocols?: string[];
  /** Extra request headers (`origin`, `cookie`). */
  headers?: Record<string, string>;
  /** Give up on a close handshake the server never answers. Default 5000ms. */
  closeTimeoutMs?: number;
}

const HEAD_END = [13, 10, 13, 10];

function indexOfHeadEnd(bytes: Uint8Array): number {
  outer: for (let i = 0; i + 3 < bytes.length; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== HEAD_END[j]) continue outer;
    return i;
  }
  return -1;
}

function parseHead(text: string): { status: number; headers: Record<string, string> } {
  const [statusLine = '', ...lines] = text.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(statusLine)?.[1] ?? 0), headers };
}

/** Open a WebSocket through `upgrade` (`kernel.upgrade` / `processHost.upgrade` bound to a port). */
export function connectWebSocket(upgrade: (request: HttpRequestData) => ByteChannel | undefined, options: WebSocketConnectOptions): WebSocketConnection {
  const opens = new Set<(info: { protocol: string }) => void>();
  const messages = new Set<(data: string | Uint8Array) => void>();
  const closes = new Set<(info: WebSocketCloseInfo) => void>();
  const key = webSocketKey();
  const decoder = new FrameDecoder();
  let state = 0;
  let head: Uint8Array = new Uint8Array(0);
  let fragments: Uint8Array[] = [];
  let fragmentOpcode = 0;
  let closeSent = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const headers: Record<string, string> = {
    ...options.headers,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': key,
  };
  if (options.protocols?.length) headers['sec-websocket-protocol'] = options.protocols.join(', ');
  const channel = upgrade({ method: 'GET', url: options.path, headers, body: null });

  const finish = (info: WebSocketCloseInfo) => {
    if (state === 3) return;
    state = 3;
    clearTimeout(closeTimer);
    channel?.close();
    for (const listener of closes) listener(info);
  };
  const fail = () => finish({ code: 1006, reason: '', wasClean: false });
  const sendFrame = (opcode: number, payload: Uint8Array) => channel?.send(encodeFrame(opcode, payload, { mask: true }));

  const onFrame = (opcode: number, fin: boolean, payload: Uint8Array) => {
    if (opcode === Opcode.ping) return sendFrame(Opcode.pong, payload);
    if (opcode === Opcode.pong) return;
    if (opcode === Opcode.close) {
      const { code, reason } = decodeClosePayload(payload);
      if (!closeSent) {
        closeSent = true;
        sendFrame(Opcode.close, code === 1005 ? new Uint8Array() : encodeClosePayload(code));
      }
      return finish({ code, reason, wasClean: true });
    }
    if (opcode !== Opcode.continuation) {
      fragmentOpcode = opcode;
      fragments = [];
    }
    fragments.push(payload);
    if (!fin) return;
    const whole = fragments.length === 1 ? fragments[0]! : joinChunks(fragments);
    fragments = [];
    const data = fragmentOpcode === Opcode.text ? new TextDecoder().decode(whole) : whole;
    for (const listener of messages) listener(data);
  };

  const onBytes = (bytes: Uint8Array) => {
    if (state === 3) return;
    let rest = bytes;
    if (state === 0) {
      head = joinChunks([head, bytes]);
      const end = indexOfHeadEnd(head);
      if (end < 0) return;
      const reply = parseHead(new TextDecoder().decode(head.subarray(0, end)));
      rest = head.subarray(end + 4);
      if (reply.status !== 101 || reply.headers['sec-websocket-accept'] !== webSocketAccept(key)) return fail();
      state = 1;
      const protocol = reply.headers['sec-websocket-protocol'] ?? '';
      for (const listener of opens) listener({ protocol });
    }
    for (const frame of decoder.push(rest)) {
      onFrame(frame.opcode, frame.fin, frame.payload);
      if (state === 3) return;
    }
  };

  if (!channel) queueMicrotask(fail);
  else {
    channel.onData(onBytes);
    channel.onClose(fail);
  }

  return {
    get readyState() {
      return state;
    },
    onOpen: (listener) => subscribe(opens, listener),
    onMessage: (listener) => subscribe(messages, listener),
    onClose: (listener) => subscribe(closes, listener),
    send(data) {
      if (state !== 1) return;
      if (typeof data === 'string') sendFrame(Opcode.text, new TextEncoder().encode(data));
      else sendFrame(Opcode.binary, data);
    },
    close(code, reason) {
      if (state === 0) return fail();
      if (state !== 1) return;
      state = 2;
      closeSent = true;
      sendFrame(Opcode.close, encodeClosePayload(code ?? 1000, reason));
      closeTimer = setTimeout(fail, options.closeTimeoutMs ?? 5000);
    },
  };
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
