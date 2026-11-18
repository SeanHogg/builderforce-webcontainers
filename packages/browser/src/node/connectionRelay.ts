/**
 * The page side of ONE process Worker's connections, as raw bytes over
 * postMessage (structured-cloned `Uint8Array`s — never a SharedArrayBuffer):
 *
 * - inbound: connections to the process's servers, opened by the page — an
 *   upgraded HTTP connection (a WebSocket, `socket-open`) or a raw TCP one
 *   (`socket-accept`). The page holds the server end the port registry handed
 *   it; ids are the page's.
 * - outbound: raw TCP connections the process dials (`net.connect`). The page
 *   opens them on the port registry, so the listener may be in any process (or
 *   on the page, like the database gateway); ids are the worker's.
 *
 * Bytes, flow-control credits (`*-ack`) and hang-ups travel both ways
 * (relayedChannels.ts). When the process ends, `closeAll` hangs up on
 * everything, so the other side hears it.
 */
import { WORKSPACE_CONTEXT, type ByteChannel, type HttpRequestData, type PortRegistry, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { HostToWorker, WorkerToHost } from './protocol.js';
import { RelayedChannels } from './relayedChannels.js';

type ConnectionMessage = Extract<WorkerToHost, { type: 'socket-data' | 'socket-ack' | 'socket-close' | 'dial' | 'dial-data' | 'dial-ack' | 'dial-close' }>;

const CONNECTION_MESSAGES = new Set<string>(['socket-data', 'socket-ack', 'socket-close', 'dial', 'dial-data', 'dial-ack', 'dial-close']);

export function isConnectionMessage(message: WorkerToHost): message is ConnectionMessage {
  return CONNECTION_MESSAGES.has(message.type);
}

/**
 * Who the process this relay serves is, bound when the page creates the relay
 * for ONE Worker's page-side record — never read from a message the Worker
 * sends (a Worker can put any pid or app in those).
 */
export interface ConnectionRelayIdentity {
  /** The pid the PAGE allocated for this relay's Worker (`ProcessHost.spawnChild`'s `allocatePid()`). */
  readonly pid: number;
  /** The page-side identity of `pid` now; undefined (an unknown or exited process) refuses every dial. */
  identityOf(pid: number): SecurityContext | undefined;
}

export class ConnectionRelay {
  /** Connections to the process's servers, by the page's id: the server end. */
  private readonly inbound: RelayedChannels<'socket'>;
  /** Connections the process dialled, by the worker's id: the client end. */
  private readonly outbound: RelayedChannels<'dial'>;
  private nextConn = 1;

  /**
   * `identity` omitted: the process is the workspace's (a runtime that mints no
   * identities yet). Given: every dial is decided as `identityOf(pid)`.
   */
  constructor(
    private readonly ports: PortRegistry,
    private readonly post: (message: HostToWorker) => void,
    private readonly identity?: ConnectionRelayIdentity,
  ) {
    this.inbound = new RelayedChannels('socket', post);
    this.outbound = new RelayedChannels('dial', post);
  }

  /** A client asked the process's server on `port` to upgrade (a WebSocket); `socket` is the server end. */
  upgrade(port: number, request: HttpRequestData, socket: ByteChannel): void {
    const connId = this.nextConn++;
    this.inbound.add(connId, socket);
    this.post({ type: 'socket-open', connId, port, request });
  }

  /** A raw TCP connection to the process's `net.Server` on `port`; `socket` is the server end. */
  accept(port: number, socket: ByteChannel): void {
    const connId = this.nextConn++;
    this.inbound.add(connId, socket);
    this.post({ type: 'socket-accept', connId, port });
  }

  receive(message: ConnectionMessage): void {
    if (message.type === 'dial') return this.dial(message.connId, message.port);
    if (this.inbound.owns(message)) return this.inbound.receive(message);
    if (this.outbound.owns(message)) return this.outbound.receive(message);
  }

  /** The process is gone: hang up on every connection it had, in both directions. */
  closeAll(): void {
    this.inbound.closeAll();
    this.outbound.closeAll();
  }

  /** Decided as the relay's bound process; nothing in the message names the caller. A refusal is `ECONNREFUSED`, like nothing listening. */
  private dial(connId: number, port: number): void {
    const caller = this.identity ? this.identity.identityOf(this.identity.pid) : WORKSPACE_CONTEXT;
    const client = caller ? this.ports.connect(port, caller) : undefined;
    this.post({ type: 'dial-result', connId, ok: client !== undefined });
    if (client) this.outbound.add(connId, client);
  }
}
