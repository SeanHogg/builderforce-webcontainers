/**
 * `net.Socket` over the runtime's virtual TCP: a Duplex whose bytes run over a
 * {@link ByteChannel} to a listener in this process or any other process of the
 * same runtime. Loopback only — a host other than localhost is refused, never
 * dialled on the network.
 *
 * The Node semantics drivers rely on: `'connect'`/`'ready'`, `'data'` as Buffers,
 * `'end'` then `'close'` when the other side hangs up, `'error'` with
 * `ECONNREFUSED` when nothing listens, writes queued while connecting, write
 * callbacks, and real backpressure — a writer may have {@link SEND_WINDOW} bytes
 * unconsumed by the reader in flight before `write()` returns false, and
 * `'drain'` follows once the reader catches up.
 *
 * Not modelled: half-open connections. `end()` closes the whole connection (as
 * `allowHalfOpen: false` peers do anyway), so a reply sent after the other side
 * called `end()` is not delivered.
 */
import { Buffer } from '../buffer.js';
import { Duplex } from '../stream/index.js';
import type { EventLoop, Timeout } from '../loop.js';
import type { ByteChannel, System } from '../../system/types.js';

export interface NetDeps {
  system: System;
  loop: EventLoop;
}

type Callback = (error?: Error | null) => void;

/** Bytes a socket may have sent that the reader has not consumed before its writes wait. */
export const SEND_WINDOW = 64 * 1024;

/** Hosts that mean "this machine". Every other host is refused. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::', '']);

let nextLocalPort = 40000;
/** A local port for a new connection end, as the OS would pick one. */
export const ephemeralPort = () => (nextLocalPort = nextLocalPort >= 48999 ? 40000 : nextLocalPort + 1);

/** A connect failure shaped like Node's (`code`, `errno`, `syscall`, `address`, `port`). */
export function connectError(code: 'ECONNREFUSED' | 'ENOENT', address: string, port: number | undefined, detail?: string): Error {
  const errno = code === 'ECONNREFUSED' ? -111 : -2;
  const target = port === undefined ? address : `${address}:${port}`;
  return Object.assign(new Error(`connect ${code} ${target}${detail ? ` (${detail})` : ''}`), { code, errno, syscall: 'connect', address, port });
}

interface ConnectTarget {
  port?: number;
  host: string;
  path?: string;
  callback?: () => void;
}

/** `connect(port[, host][, cb])`, `connect({ port, host })`, `connect(path[, cb])`. */
export function connectTarget(args: unknown[]): ConnectTarget {
  const callback = typeof args[args.length - 1] === 'function' ? (args[args.length - 1] as () => void) : undefined;
  const [first, second] = args;
  if (first && typeof first === 'object') {
    const options = first as { port?: number | string; host?: string; path?: string };
    return { port: options.port === undefined ? undefined : Number(options.port), host: options.host ?? 'localhost', path: options.path, callback };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { host: 'localhost', path: first, callback };
  return { port: Number(first), host: typeof second === 'string' ? second : 'localhost', callback };
}

export class NetSocket extends Duplex {
  remoteAddress?: string;
  remotePort?: number;
  remoteFamily?: string;
  localAddress?: string;
  localPort?: number;
  connecting = false;
  pending = true;
  bytesRead = 0;
  bytesWritten = 0;
  timeout?: number;
  private channel?: ByteChannel;
  private readonly unsubscribe: Array<() => void> = [];
  /** Writes made while connecting, sent once connected. */
  private queued: Array<{ chunk: Uint8Array; callback: Callback }> = [];
  private endAfterConnect = false;
  /** Bytes sent and not yet consumed by the reader. */
  private inFlight = 0;
  private waitingWrite?: Callback;
  /** Bytes pushed to this socket's reader and not yet acknowledged to the writer. */
  private unacknowledged = 0;
  private release?: () => void;
  private idle?: Timeout;

  constructor(private readonly deps: NetDeps, options: { allowHalfOpen?: boolean } = {}) {
    super({ allowHalfOpen: options.allowHalfOpen ?? false });
  }

  get readyState(): string {
    if (this.connecting) return 'opening';
    if (this.readable && this.writable) return 'open';
    if (this.readable) return 'readOnly';
    return this.writable && this.channel ? 'writeOnly' : 'closed';
  }

  connect(...args: unknown[]): this {
    const target = connectTarget(args);
    if (target.callback) this.once('connect', target.callback);
    this.connecting = true;
    this.hold();
    const host = target.host.replace(/^\[|\]$/g, '');
    const refuse = (error: Error) => queueMicrotask(() => this.deps.loop._run(() => this.fail(error)));
    if (target.path !== undefined) {
      refuse(connectError('ENOENT', target.path, undefined, 'Unix sockets are not available in the browser runtime'));
      return this;
    }
    if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
      refuse(connectError('ECONNREFUSED', host, target.port, 'only localhost is reachable from the browser runtime'));
      return this;
    }
    const port = target.port!;
    void this.deps.system.connect(port).then(
      (channel) =>
        this.deps.loop._run(() => {
          if (this.destroyed) return channel?.close();
          if (!channel) return this.fail(connectError('ECONNREFUSED', '127.0.0.1', port));
          this._attach(channel, { remotePort: port, localPort: ephemeralPort() });
          this.emit('connect');
          this.emit('ready');
        }),
      (error: Error) => this.deps.loop._run(() => this.fail(error)),
    );
    return this;
  }

  /** Bind to an open connection (a client that connected, or a server's accepted end). */
  _attach(channel: ByteChannel, ports: { remotePort: number; localPort: number }): void {
    this.channel = channel;
    this.connecting = false;
    this.pending = false;
    this.remoteAddress = this.localAddress = '127.0.0.1';
    this.remoteFamily = 'IPv4';
    this.remotePort = ports.remotePort;
    this.localPort = ports.localPort;
    this.hold();
    channel.manualFlowControl(); // credits follow what this socket's reader consumes
    this.unsubscribe.push(
      channel.onData((data) => {
        this.bytesRead += data.byteLength;
        this.touch();
        if (this.push(Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength))) channel.consumed(data.byteLength);
        else this.unacknowledged += data.byteLength;
      }),
      channel.onConsumed((bytes) => this.credit(bytes)),
      // The other side hung up: writes waiting for credit will never get it.
      channel.onClose(() => this.hangUp()),
    );
    const queued = this.queued;
    this.queued = [];
    for (const { chunk, callback } of queued) this.send(chunk, callback);
    if (this.endAfterConnect) this.hangUp();
  }

  /** The connection is closed (either side): the readable side ends, and it no longer keeps the process alive. */
  private hangUp(): void {
    this.channel?.close();
    this.credit(Infinity);
    this.push(null);
    this.release?.();
    this.release = undefined;
  }

  override _read(): void {
    if (!this.unacknowledged || !this.channel) return;
    this.channel.consumed(this.unacknowledged);
    this.unacknowledged = 0;
  }

  _write(chunk: Uint8Array, _encoding: string, callback: Callback): void {
    if (this.channel) this.send(chunk, callback);
    else this.queued.push({ chunk, callback });
  }

  /** Corked writes (a driver's Parse/Bind/Execute/Sync) leave as one send, as one TCP segment would carry them. */
  override _writev = (chunks: Array<{ chunk: Uint8Array }>, callback: Callback): void => {
    const joined = new Uint8Array(chunks.reduce((sum, { chunk }) => sum + chunk.byteLength, 0));
    let at = 0;
    for (const { chunk } of chunks) {
      joined.set(chunk, at);
      at += chunk.byteLength;
    }
    this._write(joined, 'buffer', callback);
  };

  /** `end()`: connections close as a whole (no half-open state), so the readable side ends too. */
  _final(callback: Callback): void {
    if (this.channel) this.hangUp();
    else this.endAfterConnect = true;
    callback();
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.channel?.close();
    this.unsubscribe.splice(0).forEach((stop) => stop());
    this.credit(Infinity);
    this.connecting = false;
    if (this.idle) this.deps.loop.clearTimeout(this.idle);
    this.release?.();
    this.release = undefined;
    callback(error);
  }

  setTimeout(ms: number, callback?: () => void): this {
    if (this.idle) this.deps.loop.clearTimeout(this.idle);
    this.idle = undefined;
    this.timeout = ms;
    if (callback) this.once('timeout', callback);
    if (ms > 0) this.idle = this.deps.loop.setTimeout(() => this.emit('timeout'), ms).unref();
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  address() { return this.localPort === undefined ? {} : { address: '127.0.0.1', family: 'IPv4', port: this.localPort }; }
  ref(): this {
    if (!this.destroyed && (this.connecting || (this.channel && !this.channel.closed))) this.hold();
    return this;
  }
  unref(): this {
    this.release?.();
    this.release = undefined;
    return this;
  }
  destroySoon(): void { this.end(); }
  resetAndDestroy(): this { return this.destroy(); }

  private send(chunk: Uint8Array, callback: Callback): void {
    this.bytesWritten += chunk.byteLength;
    this.touch();
    this.channel!.send(chunk);
    this.inFlight += chunk.byteLength;
    if (this.inFlight <= SEND_WINDOW || this.channel!.closed) callback();
    else this.waitingWrite = callback;
  }

  /** The reader consumed `bytes`: a write waiting for room may finish. */
  private credit(bytes: number): void {
    this.inFlight = Math.max(0, this.inFlight - bytes);
    if (!this.waitingWrite || this.inFlight > SEND_WINDOW) return;
    const callback = this.waitingWrite;
    this.waitingWrite = undefined;
    callback();
  }

  private fail(error: Error): void {
    this.connecting = false;
    this.destroy(error);
  }

  /** An open (or opening) socket keeps the process alive, as a real one does. */
  private hold(): void {
    this.release ??= this.deps.loop.hold();
  }

  private touch(): void {
    this.idle?.refresh();
  }
}
