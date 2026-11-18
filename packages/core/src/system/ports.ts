/**
 * The virtual network: which handler serves which port. One registry per
 * runtime (kernel or browser host), shared by every process in it, so a server
 * in one process is reachable from another (`fetch('http://localhost:3000')`)
 * and from the preview service worker (`/__bfwc/<id>/__port/3000/`).
 *
 * Every port records its owner (make.md › PRD 31 §4 W10, control 4): the
 * (application, service) the runtime assigned to whoever listened — the
 * platform when the host listens itself. Every `request`, `upgrade` and
 * `connect` names its caller (the host's own calls are the platform) and is
 * decided by the injected {@link PortAccessPolicy}. A refusal looks exactly like
 * nothing listening, so a process cannot probe for ports it may not reach; the
 * decision itself goes to `onDecision` (telemetry: a failing hook never changes
 * the outcome). A policy that throws refuses (fail closed).
 */
import { addressInUseError, type ByteChannel, type ConnectionHandler, type HttpHandler, type HttpRequestData, type HttpResponseData, type HttpStreamResponse, type UpgradeHandler } from './types.js';
import { bufferResponse } from './httpStream.js';
import { acceptConnection, createChannelPair } from './byteChannel.js';
import { deny, PLATFORM_CONTEXT, type SecurityContext, type ShieldDecision } from './securityContext.js';
import { ServiceGraphPolicy } from '../app/servicePortPolicy.js';

export interface PortEvent {
  type: 'open' | 'close';
  port: number;
}

/** Decides whether `caller` may reach a port `owner` listens on. */
export interface PortAccessPolicy {
  decide(caller: SecurityContext, owner: SecurityContext): ShieldDecision;
}

/** One access decision, as `onDecision` reports it. */
export interface PortDecisionEvent {
  operation: 'request' | 'upgrade' | 'connect';
  port: number;
  caller: SecurityContext;
  owner: SecurityContext;
  decision: ShieldDecision;
}

export interface PortRegistryOptions {
  /** Default: a {@link ServiceGraphPolicy} with no applications registered (workspace and platform callers only). */
  policy?: PortAccessPolicy;
  /** Every decision on a port something listens on. Telemetry only: errors are swallowed. */
  onDecision?(event: PortDecisionEvent): void;
}

const EPHEMERAL_START = 49152;

export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  private readonly upgrades = new Map<number, UpgradeHandler>();
  private readonly connections = new Map<number, ConnectionHandler>();
  private readonly owners = new Map<number, SecurityContext>();
  private readonly listeners = new Set<(event: PortEvent) => void>();
  private nextEphemeral = EPHEMERAL_START;
  readonly policy: PortAccessPolicy;
  private readonly onDecision?: (event: PortDecisionEvent) => void;

  constructor(options: PortRegistryOptions = {}) {
    this.policy = options.policy ?? new ServiceGraphPolicy();
    this.onDecision = options.onDecision;
  }

  /**
   * `connection` takes raw TCP connections (a `net.Server`, a database gateway).
   * `owner` is who listens, as the page side assigned it; omitted, the port is
   * the platform's, which no application process can reach.
   */
  listen(port: number, handler: HttpHandler, upgrade?: UpgradeHandler, connection?: ConnectionHandler, owner: SecurityContext = PLATFORM_CONTEXT): { port: number; close(): void } {
    let actual = port;
    if (!actual) {
      while (this.handlers.has(this.nextEphemeral)) this.nextEphemeral++;
      actual = this.nextEphemeral++;
    }
    if (this.handlers.has(actual)) {
      throw addressInUseError(actual);
    }
    this.handlers.set(actual, handler);
    this.owners.set(actual, owner);
    if (upgrade) this.upgrades.set(actual, upgrade);
    if (connection) this.connections.set(actual, connection);
    this.emit({ type: 'open', port: actual });
    let open = true;
    return {
      port: actual,
      close: () => {
        if (!open || this.handlers.get(actual) !== handler) return;
        open = false;
        this.handlers.delete(actual);
        this.upgrades.delete(actual);
        this.connections.delete(actual);
        this.emit({ type: 'close', port: actual }); // the owner is still known here, so watchers can tell who could reach it (`reaches`)
        this.owners.delete(actual);
      },
    };
  }

  has(port: number): boolean {
    return this.handlers.has(port);
  }

  /** Who listens on `port`, or undefined when nothing does. */
  ownerOf(port: number): SecurityContext | undefined {
    return this.owners.get(port);
  }

  /** Every open port — the host's view. A process gets {@link reachablePorts} instead, so it cannot list ports it may not reach. */
  ports(): number[] {
    return [...this.handlers.keys()].sort((a, b) => a - b);
  }

  /** Could `caller` reach `port`? Decided like a connection, but not reported (listing is not an access). False when nothing listens (during a port's `close` event, still its owner's answer). */
  reaches(port: number, caller: SecurityContext): boolean {
    const owner = this.owners.get(port);
    if (!owner) return false;
    try {
      return this.policy.decide(caller, owner).allow;
    } catch {
      return false;
    }
  }

  /** The open ports `caller` may reach: what a process is told is listening. */
  reachablePorts(caller: SecurityContext): number[] {
    return this.ports().filter((port) => this.reaches(port, caller));
  }

  /**
   * Dispatch to the server on `port`; resolves with the head as soon as it is
   * written, the body streaming. Undefined when nothing listens there — or when
   * `caller` may not reach it.
   */
  async request(port: number, request: HttpRequestData, caller: SecurityContext = PLATFORM_CONTEXT): Promise<HttpStreamResponse | undefined> {
    const handler = this.handlers.get(port);
    return handler && this.admits('request', port, caller) ? handler(request) : undefined;
  }

  /** {@link request}, waiting for the whole body. */
  async requestBuffered(port: number, request: HttpRequestData, caller: SecurityContext = PLATFORM_CONTEXT): Promise<HttpResponseData | undefined> {
    const response = await this.request(port, request, caller);
    return response && bufferResponse(response);
  }

  /** Open an upgraded connection to the server on `port`; returns the client end, or undefined when nothing there takes upgrades (or `caller` may not reach it). */
  upgrade(port: number, request: HttpRequestData, caller: SecurityContext = PLATFORM_CONTEXT): ByteChannel | undefined {
    const upgrade = this.upgrades.get(port);
    if (!upgrade || !this.admits('upgrade', port, caller)) return undefined;
    const [client, server] = createChannelPair();
    upgrade(request, server);
    return client;
  }

  /**
   * Open a raw TCP connection to whatever listens on `port`; returns the client
   * end, or undefined when nothing listens or `caller` may not reach it
   * (`ECONNREFUSED` either way). A port that serves only HTTP accepts and drops
   * the connection (see `acceptConnection`). The listener's connection handler
   * hears `caller`.
   */
  connect(port: number, caller: SecurityContext = PLATFORM_CONTEXT): ByteChannel | undefined {
    if (!this.handlers.has(port) || !this.admits('connect', port, caller)) return undefined;
    const handler = this.connections.get(port);
    return acceptConnection(handler && ((socket) => handler(socket, caller)));
  }

  watch(listener: (event: PortEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private admits(operation: PortDecisionEvent['operation'], port: number, caller: SecurityContext): boolean {
    const owner = this.owners.get(port) ?? PLATFORM_CONTEXT;
    let decision: ShieldDecision;
    try {
      decision = this.policy.decide(caller, owner);
    } catch {
      decision = deny('port.not_owner'); // a broken policy refuses, never allows
    }
    try {
      this.onDecision?.({ operation, port, caller, owner, decision });
    } catch {
      // telemetry fails open
    }
    return decision.allow;
  }

  private emit(event: PortEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** `/__port/3000/api?x` → port 3000, path `/api`. Undefined for any other path. */
export function parsePortPath(path: string): { port: number; path: string } | undefined {
  const m = /^\/__port\/(\d{1,5})(\/.*)?$/.exec(path);
  if (!m) return undefined;
  return { port: Number(m[1]), path: m[2] ?? '/' };
}
