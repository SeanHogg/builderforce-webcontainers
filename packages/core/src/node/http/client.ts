/**
 * Outbound HTTP: `http.request`/`http.get` (ClientRequest → IncomingMessage) and
 * the `fetch` global a program sees. Requests to localhost reach this runtime's
 * own virtual servers (`loopback`); everything else goes through the browser's
 * fetch, so CORS applies — a public API without CORS headers is unreachable
 * from a browser page, and no shim can change that.
 */
import { Buffer } from '../buffer.js';
import type { EventLoop } from '../loop.js';
import type { HttpRequestData, System } from '../../system/types.js';
import { FakeSocket, IncomingMessage, OutgoingHeaders } from './server.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
/** Headers a browser refuses to let script set; dropping them beats a TypeError. */
const FORBIDDEN = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade', 'expect', 'te', 'trailer', 'proxy-connection']);

export interface ClientDeps {
  system: System;
  loop: EventLoop;
}

interface RequestOptions {
  protocol?: string;
  host?: string;
  hostname?: string;
  port?: number | string;
  path?: string;
  method?: string;
  headers?: Record<string, string | number | string[]>;
  auth?: string;
  timeout?: number;
  signal?: AbortSignal;
}

function toOptions(input: unknown, extra: unknown, defaultProtocol: string): RequestOptions {
  let options: RequestOptions = {};
  if (typeof input === 'string' || input instanceof URL) {
    const url = new URL(String(input));
    options = { protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname + url.search, auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined };
    if (extra && typeof extra === 'object') options = { ...options, ...(extra as RequestOptions) };
  } else if (input && typeof input === 'object') options = { ...(input as RequestOptions) };
  options.protocol ??= defaultProtocol;
  if (!options.hostname && options.host) {
    const [h, p] = options.host.split(':');
    options.hostname = h;
    options.port ??= p;
  }
  options.hostname ??= 'localhost';
  options.path ??= '/';
  options.method = (options.method ?? 'GET').toUpperCase();
  return options;
}

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => (out[key] = value));
  return out;
}

/** Perform a request against loopback or the network; returns a Fetch Response. */
export async function sendRequest(system: System, url: URL, request: HttpRequestData, signal?: AbortSignal): Promise<Response> {
  if (isLocalHost(url.hostname)) {
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const reply = await system.loopback(port, request);
    if (!reply) throw Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '127.0.0.1', port });
    const headers = new Headers();
    for (const [k, v] of Object.entries(reply.headers)) for (const item of Array.isArray(v) ? v : [v]) headers.append(k, String(item));
    const empty = reply.status === 204 || reply.status === 304 || request.method === 'HEAD';
    return new Response(empty ? null : (reply.body as unknown as BodyInit), { status: reply.status, statusText: reply.statusText, headers });
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(request.headers)) if (!FORBIDDEN.has(k.toLowerCase())) headers[k] = v;
  const hasBody = request.body && request.method !== 'GET' && request.method !== 'HEAD';
  return system.fetch(url.href, { method: request.method, headers, body: hasBody ? (request.body as unknown as BodyInit) : undefined, signal });
}

export class ClientRequest extends OutgoingHeaders {
  method: string;
  path: string;
  host: string;
  protocol: string;
  aborted = false;
  reusedSocket = false;
  socket = new FakeSocket();
  connection = this.socket;
  private readonly chunks: Uint8Array[] = [];
  private readonly controller = new AbortController();
  private readonly options: RequestOptions;

  constructor(private readonly deps: ClientDeps, input: unknown, extra: unknown, callback: ((res: IncomingMessage) => void) | undefined, defaultProtocol: string) {
    super({ decodeStrings: true });
    if (typeof extra === 'function') [callback, extra] = [extra as typeof callback, undefined];
    this.options = toOptions(input, extra, defaultProtocol);
    this.method = this.options.method!;
    this.path = this.options.path!;
    this.host = this.options.hostname!;
    this.protocol = this.options.protocol!;
    for (const [k, v] of Object.entries(this.options.headers ?? {})) this.setHeader(k, v as string);
    if (this.options.auth && !this.hasHeader('authorization')) this.setHeader('authorization', `Basic ${Buffer.from(this.options.auth).toString('base64')}`);
    if (callback) this.once('response', callback);
    this.options.signal?.addEventListener('abort', () => this.destroy(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })));
  }

  override _write(chunk: Uint8Array, _encoding: string, callback: () => void): void {
    this.chunks.push(chunk);
    callback();
  }

  override _final(callback: () => void): void {
    this.headersSent = true;
    callback();
    void this.perform();
  }

  abort(): void {
    this.aborted = true;
    this.controller.abort();
    this.emit('abort');
    this.destroy();
  }

  override destroy(error?: Error | null): this {
    this.controller.abort();
    return super.destroy(error);
  }

  setNoDelay(): void {}
  setSocketKeepAlive(): void {}

  private async perform(): Promise<void> {
    const release = this.deps.loop.hold();
    try {
      const port = this.options.port ? `:${this.options.port}` : '';
      const host = this.host.includes(':') ? `[${this.host}]` : this.host;
      const url = new URL(`${this.protocol}//${host}${port}${this.path}`);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(this.getHeaders())) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      const body = this.chunks.length ? Buffer.concat(this.chunks) : null;
      const response = await sendRequest(this.deps.system, url, { method: this.method, url: this.path, headers, body }, this.controller.signal);
      const res = new IncomingMessage(this.socket);
      res.statusCode = response.status;
      res.statusMessage = response.statusText;
      res._fill(headersToRecord(response.headers), new Uint8Array(await response.arrayBuffer()));
      this.deps.loop._run(() => {
        if (!this.emit('response', res)) res.resume();
      });
    } catch (error) {
      if (!this.aborted) this.deps.loop._run(() => this.emit('error', error));
    } finally {
      release();
    }
  }
}

/** The `fetch` a program sees: loopback-aware and counted as pending work. */
export function createFetch(deps: ClientDeps): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const release = deps.loop.hold();
    try {
      const request = new Request(input instanceof URL ? input.href : input, init);
      const url = new URL(request.url);
      if (!isLocalHost(url.hostname)) return await deps.system.fetch(url.href, init ?? (typeof input === 'object' && !(input instanceof URL) ? { method: request.method, headers: request.headers, body: request.body, signal: request.signal } : undefined));
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
      return await sendRequest(deps.system, url, { method: request.method, url: url.pathname + url.search, headers: headersToRecord(request.headers), body });
    } finally {
      release();
    }
  };
}
