/**
 * The virtual network: which handler serves which port. One registry per
 * runtime (kernel or browser host), shared by every process in it, so a server
 * in one process is reachable from another (`fetch('http://localhost:3000')`)
 * and from the preview service worker (`/__bfwc/<id>/__port/3000/`).
 */
import type { HttpHandler, HttpRequestData, HttpResponseData } from './types.js';

export interface PortEvent {
  type: 'open' | 'close';
  port: number;
}

const EPHEMERAL_START = 49152;

export class PortRegistry {
  private readonly handlers = new Map<number, HttpHandler>();
  private readonly listeners = new Set<(event: PortEvent) => void>();
  private nextEphemeral = EPHEMERAL_START;

  listen(port: number, handler: HttpHandler): { port: number; close(): void } {
    let actual = port;
    if (!actual) {
      while (this.handlers.has(this.nextEphemeral)) this.nextEphemeral++;
      actual = this.nextEphemeral++;
    }
    if (this.handlers.has(actual)) {
      throw Object.assign(new Error(`listen EADDRINUSE: address already in use :::${actual}`), { code: 'EADDRINUSE', errno: -98, syscall: 'listen', address: '::', port: actual });
    }
    this.handlers.set(actual, handler);
    this.emit({ type: 'open', port: actual });
    let open = true;
    return {
      port: actual,
      close: () => {
        if (!open || this.handlers.get(actual) !== handler) return;
        open = false;
        this.handlers.delete(actual);
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

  /** Dispatch to the server on `port`; undefined when nothing listens there. */
  async request(port: number, request: HttpRequestData): Promise<HttpResponseData | undefined> {
    const handler = this.handlers.get(port);
    return handler ? handler(request) : undefined;
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
