/**
 * PHP's sockets on the runtime's virtual TCP. php-wasm's socket layer
 * (Emscripten SOCKFS) opens every TCP connection as a WebSocket, built from the
 * module's `websocket` config at `connect` time; this module points that config
 * at a WebSocket-shaped adapter over the process protocol's dialled
 * connections (`dial` / `dial-result` / `dial-data` / `dial-ack` / `dial-close`,
 * the same worker-side relay Node's `net.connect` and Python's sockets use).
 * So `stream_socket_client('tcp://localhost:5432')`, `fsockopen` — and the
 * runtime's Postgres client on top of them (pgsql/) — reach whatever listens on
 * that virtual port, in any process: the Postgres wire gateway, another
 * service. As for Node's `net`, only localhost is reachable; no SharedArrayBuffer.
 *
 * As with php-wasm's own WebSocket networking, `connect` returns before the
 * far end answers: a port nothing listens on shows as end of stream on the
 * first read (the runtime's Postgres client reports it as a refused
 * connection). Blocking reads (`fread`, `fgets`) wait in php-wasm's JSPI build (its
 * `wasm_poll_socket`); the bytes PHP has not read yet queue in SOCKFS, so reads
 * credit the far end as they are delivered (the channel's default).
 *
 * The adapter speaks both event styles SOCKFS uses — Node's (`on`, `once`,
 * `removeListener`, as its Node build expects) and the DOM's (`onopen`,
 * `onmessage`, `addEventListener`, as its web build does).
 */
import type { ByteChannel } from '@seanhogg/builderforce-webcontainers-core';
import type { PhpModuleLike, WebSocketConstructorLike } from './phpLoader.js';

/** Dial a virtual port: the client end, or undefined when nothing listens there. */
export type Dial = (port: number) => Promise<ByteChannel | undefined>;

/** Addresses the virtual network answers on (php-wasm resolves `localhost` to 127.0.0.1). */
export const isLocalAddress = (address: string) => /^127\./.test(address) || address === '0.0.0.0' || address === '::1' || address === 'localhost';

/** The URL SOCKFS is asked to open: the address and port, which the adapter reads back. */
const DIAL_URL = /^bfwc-tcp:\/\/\[?([^\]]*)\]?:(\d+)$/;

type Listener = (...args: unknown[]) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** A WebSocket-shaped connection to a virtual port, as SOCKFS consumes one. */
export function dialSocketClass(dial: Dial): WebSocketConstructorLike {
  return class DialSocket {
    readonly CONNECTING = CONNECTING;
    readonly OPEN = OPEN;
    readonly CLOSING = CLOSING;
    readonly CLOSED = CLOSED;
    readyState = CONNECTING;
    binaryType = 'arraybuffer';
    onopen: Listener | null = null;
    onmessage: Listener | null = null;
    onclose: Listener | null = null;
    onerror: Listener | null = null;
    private readonly listeners = new Map<string, Array<{ listener: Listener; once: boolean; dom: boolean }>>();
    private channel: ByteChannel | undefined;

    constructor(readonly url: string) {
      const match = DIAL_URL.exec(url);
      const host = match?.[1] ?? '';
      const port = Number(match?.[2]);
      if (!match || !isLocalAddress(host)) {
        queueMicrotask(() => this.fail());
        return;
      }
      dial(port).then(
        (channel) => {
          if (!channel) return this.fail();
          if (this.readyState !== CONNECTING) return channel.close(); // closed while dialling
          this.channel = channel;
          this.readyState = OPEN;
          channel.onData((data) => this.emit('message', data));
          channel.onClose(() => this.ended());
          this.emit('open');
        },
        () => this.fail(),
      );
    }

    send(data: ArrayBuffer | ArrayBufferView): void {
      if (this.readyState !== OPEN || !this.channel) return;
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.channel.send(bytes.slice());
    }

    /** Socket options (`TCP_NODELAY`, keep-alive) mean nothing on an in-memory pipe. */
    setSocketOpt(): void {}

    close(): void {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.channel?.close();
      this.ended();
    }

    on(event: string, listener: Listener) {
      return this.add(event, listener, false, false);
    }
    once(event: string, listener: Listener) {
      return this.add(event, listener, true, false);
    }
    addEventListener(event: string, listener: Listener) {
      this.add(event, listener, false, true);
    }
    removeListener(event: string, listener: Listener) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((entry) => entry.listener !== listener));
      return this;
    }
    off(event: string, listener: Listener) {
      return this.removeListener(event, listener);
    }
    removeEventListener(event: string, listener: Listener) {
      this.removeListener(event, listener);
    }

    private add(event: string, listener: Listener, once: boolean, dom: boolean) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { listener, once, dom }]);
      return this;
    }

    /** Node-style listeners get `(data, isBinary)`; DOM-style ones (and `onmessage`) an event with an ArrayBuffer. */
    private emit(event: 'open' | 'message' | 'close' | 'error', data?: Uint8Array): void {
      const entries = this.listeners.get(event) ?? [];
      this.listeners.set(event, entries.filter((entry) => !entry.once));
      const buffer = data ? data.slice().buffer : undefined;
      const domEvent = { type: event, target: this, data: buffer };
      for (const { listener, dom } of entries) {
        if (dom) listener(domEvent);
        else if (data) listener(data, true);
        else listener();
      }
      const handler = { open: this.onopen, message: this.onmessage, close: this.onclose, error: this.onerror }[event];
      handler?.(domEvent);
    }

    private ended(): void {
      if (this.readyState === CLOSED) return;
      this.readyState = CLOSED;
      this.channel = undefined;
      queueMicrotask(() => this.emit('close'));
    }

    /** ECONNREFUSED: nothing listens there, or it is not localhost. */
    private fail(): void {
      if (this.readyState === CLOSED) return;
      this.emit('error');
      this.ended();
    }
  };
}

/** Make the runtime's virtual TCP the network of PHP's sockets in this instance. */
export function installPhpSockets(module: PhpModuleLike, dial: Dial): void {
  const config = (module.websocket ??= {});
  config.url = (_socket, addr, port) => `bfwc-tcp://${addr.includes(':') ? `[${addr}]` : addr}:${port}`;
  config.subprotocol = 'binary';
  const DialSocket = dialSocketClass(dial);
  config.decorator = () => DialSocket;
}
