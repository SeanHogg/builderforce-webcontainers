/**
 * The virtual network: which handler serves which port. One registry per
 * runtime (kernel or browser host), shared by every process in it, so a server
 * in one process is reachable from another (`fetch('http://localhost:3000')`)
 * and from the preview service worker (`/__bfwc/<id>/__port/3000/`).
 */
import type { ByteChannel, HttpHandler, HttpRequestData, HttpResponseData, HttpStreamResponse, UpgradeHandler } from './types.js';
import { bufferResponse, createChannelPair } from './httpStream.js';

export interface PortEvent {
  type: 'open' | 'close';
  port: number;
}

const EPHEMERAL_START = 49152;

export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  private readonly upgrades = new Map<number, UpgradeHandler>();
  private readonly listeners = new Set<(event: PortEvent) => void>();
  private nextEphemeral = EPHEMERAL_START;

  listen(port: number, handler: HttpHandler, upgrade?: UpgradeHandler): { port: number; close(): void } {
    let actual = port;
    if (!actual) {
      while (this.handlers.has(this.nextEphemeral)) this.nextEphemeral++;
      actual = this.nextEphemeral++;
    }
    if (this.handlers.has(actual)) {
      throw Object.assign(new Error(`listen EADDRINUSE: address already in use :::${actual}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: '::', port: actual });
    }
    this.handlers.set(actual, handler);
    if (upgrade) this.upgrades.set(actual, upgrade);
    this.emit({ type: 'open', port: actual });
    let open = true;
    return {
      port: actual,
      close: () => {
        if (!open || this.handlers.get(actual) !== handler) return;
        open = false;
        this.handlers.delete(actual);
        this.upgrades.delete(actual);
        this.emit({ type: 'close', port: actual });
      },
    };
  }

  has(port: number): boolean {
    return this.handlers.has(port);
  }

  ports(): number[] {
    return [...this.handlers.keys()].sort((a, b) => a - b);
  }

  /** Dispatch to the server on `port`; resolves with the head as soon as it is written, the body streaming. Undefined when nothing listens there. */
  async request(port: number, request: HttpRequestData): Promise<HttpStreamResponse | undefined> {
    const handler = this.handlers.get(port);
    return handler ? handler(request) : undefined;
  }

  /** {@link request}, waiting for the whole body. */
  async requestBuffered(port: number, request: HttpRequestData): Promise<HttpResponseData | undefined> {
    const response = await this.request(port, request);
    return response && bufferResponse(response);
  }

  /** Open an upgraded connection to the server on `port`; returns the client end, or undefined when nothing there takes upgrades. */
  upgrade(port: number, request: HttpRequestData): ByteChannel | undefined {
    const upgrade = this.upgrades.get(port);
    if (!upgrade) return undefined;
    const [client, server] = createChannelPair();
    upgrade(request, server);
    return client;
  }

  watch(listener: (event: PortEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
