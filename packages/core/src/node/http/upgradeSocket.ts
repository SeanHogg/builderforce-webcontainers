/**
 * The socket an `http.Server` hands its `upgrade` listeners: a real Duplex
 * over the upgraded connection's byte pipe, with the slice of net.Socket that
 * WebSocket servers touch (`ws` writes its `101` reply and frames with
 * `write(data, cb)`, corks, pauses, reads `_readableState`, and calls
 * `setNoDelay`/`setTimeout`). Raw bytes only — framing is the package's job.
 */
import { Buffer } from '../buffer.js';
import { Duplex } from '../stream/index.js';
import type { ByteChannel } from '../../system/types.js';

type Callback = (error?: Error | null) => void;

export class UpgradeSocket extends Duplex {
  remoteAddress = '127.0.0.1';
  remotePort = 50000 + Math.floor(Math.random() * 10000);
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort: number;
  encrypted = false;
  connecting = false;
  bytesRead = 0;
  bytesWritten = 0;
  private release?: () => void;

  /** `hold` keeps the process alive while the connection is open, as a TCP socket would. */
  constructor(private readonly channel: ByteChannel, port: number, hold?: () => () => void) {
    super({ allowHalfOpen: false });
    this.localPort = port;
    this.release = hold?.();
    channel.onData((data) => {
      this.bytesRead += data.byteLength;
      this.push(Buffer.from(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength));
    });
    channel.onClose(() => {
      this.push(null);
      this.end();
    });
    this.once('close', () => {
      this.release?.();
      this.release = undefined;
    });
  }

  override _read(): void {
    // bytes are pushed as they arrive
  }

  _write(chunk: Uint8Array, _encoding: string, callback: Callback): void {
    this.bytesWritten += chunk.byteLength;
    this.channel.send(chunk);
    callback();
  }

  _final(callback: Callback): void {
    this.channel.close();
    this.push(null);
    callback();
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.channel.close();
    callback(error);
  }

  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.once('timeout', cb);
    return this;
  }
  setNoDelay(): this { return this; }
  setKeepAlive(): this { return this; }
  address() { return { address: this.localAddress, family: 'IPv4', port: this.localPort }; }
  ref(): this { return this; }
  unref(): this {
    this.release?.();
    this.release = undefined;
    return this;
  }
}
