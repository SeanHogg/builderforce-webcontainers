/**
 * `net.Server` on a virtual port: `listen(port)` registers the port with the
 * runtime (so port probes and `EADDRINUSE` stay truthful) and takes raw TCP
 * connections from any process of the runtime, each as a {@link NetSocket}
 * through `'connection'`. An HTTP request to the port gets a 502 — it is not an
 * HTTP server.
 */
import { EventEmitterBase } from '../events.js';
import { queueCallback } from '../processExit.js';
import { textResponse } from '../../system/httpStream.js';
import type { ByteChannel } from '../../system/types.js';
import { ephemeralPort, type NetDeps, type NetSocket } from './socket.js';

export class NetServer extends EventEmitterBase {
  listening = false;
  maxConnections?: number;
  private registration?: { port: number; close(): void };
  private release?: () => void;
  private readonly sockets = new Set<NetSocket>();
  private closing = false;

  constructor(
    private readonly deps: NetDeps,
    private readonly createSocket: () => NetSocket,
    options?: unknown,
    connectionListener?: (socket: NetSocket) => void,
  ) {
    super();
    if (typeof options === 'function') connectionListener = options as typeof connectionListener;
    if (connectionListener) this.on('connection', connectionListener);
  }

  listen(...args: unknown[]): this {
    const callback = typeof args[args.length - 1] === 'function' ? (args.pop() as () => void) : undefined;
    const first = args[0];
    const port = typeof first === 'object' && first ? Number((first as { port?: number }).port ?? 0) : Number(first ?? 0);
    if (callback) this.once('listening', callback);
    try {
      this.registration = this.deps.system.listen(port, async () => textResponse(502, 'Not an HTTP server'), undefined, (channel) => this.accept(channel));
    } catch (error) {
      queueCallback(() => this.emit('error', error));
      return this;
    }
    this.listening = true;
    this.closing = false;
    this.release = this.deps.loop.hold();
    queueCallback(() => this.emit('listening'));
    return this;
  }

  address() {
    return this.registration ? { address: '::', family: 'IPv6', port: this.registration.port } : null;
  }

  /** Stop taking connections; `'close'` once every open connection has ended too (as Node does). */
  close(callback?: (error?: Error) => void): this {
    if (!this.registration) {
      if (callback) queueCallback(() => callback(Object.assign(new Error('Server is not running.'), { code: 'ERR_SERVER_NOT_RUNNING' })));
      return this;
    }
    this.registration.close();
    this.registration = undefined;
    this.listening = false;
    this.closing = true;
    this.release?.();
    this.release = undefined;
    if (callback) this.once('close', callback);
    this.closeWhenIdle();
    return this;
  }

  getConnections(callback: (error: null, count: number) => void): void {
    queueCallback(() => callback(null, this.sockets.size));
  }

  ref(): this {
    if (this.registration && !this.release) this.release = this.deps.loop.hold();
    return this;
  }

  unref(): this {
    this.release?.();
    this.release = undefined;
    return this;
  }

  private accept(channel: ByteChannel): void {
    if (!this.registration || (this.maxConnections !== undefined && this.sockets.size >= this.maxConnections)) return channel.close();
    const socket = this.createSocket();
    socket._attach(channel, { remotePort: ephemeralPort(), localPort: this.registration.port });
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.closeWhenIdle();
    });
    this.deps.loop._run(() => this.emit('connection', socket));
  }

  private closeWhenIdle(): void {
    if (!this.closing || this.sockets.size) return;
    this.closing = false;
    queueCallback(() => this.emit('close'));
  }
}
