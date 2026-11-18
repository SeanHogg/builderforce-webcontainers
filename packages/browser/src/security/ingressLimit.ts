/**
 * The request-body limit on ingress that never crosses the service worker
 * (make.md › PRD 31 §4 W10, control 3): in-runtime loopback HTTP (a process
 * asking a server in the runtime) and the host API (`runtime.request`). The
 * limit is the service worker's own (`DEFAULT_MAX_BODY_BYTES`, swBody.ts), so
 * every HTTP path into a server is held to the same bound. Decided on the page
 * side, before the request reaches the server; refused with 413 and an
 * `ingress.body_too_large` event naming the page-side caller.
 */
import { textResponse, type HttpRequestData, type HttpStreamResponse, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { DEFAULT_MAX_BODY_BYTES } from '../swBody.js';
import type { ShieldTelemetry } from './shieldTelemetry.js';

export interface IngressLimitOptions {
  /** Largest request body, in bytes. Default `DEFAULT_MAX_BODY_BYTES` (32 MiB, the service worker's). */
  maxBodyBytes?: number;
  telemetry?: ShieldTelemetry;
}

/** Which non-service-worker path a request came in on (evidence only). */
export type IngressPath = 'loopback' | 'host';

/** A body's size, whatever a Worker's message put there (a loopback request is untrusted input): bytes, a buffer, or a string's UTF-16 length (a lower bound of its UTF-8 size). */
function bodyBytes(body: unknown): number {
  if (body === null || body === undefined) return 0;
  if (typeof body === 'string') return body.length;
  const size = (body as { byteLength?: unknown }).byteLength;
  return typeof size === 'number' && Number.isFinite(size) ? size : 0;
}

export class IngressLimit {
  readonly maxBodyBytes: number;

  constructor(private readonly options: IngressLimitOptions = {}) {
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /** A 413 when `request`'s body is over the limit (reported as `caller`); undefined to let it through. */
  refuse(port: number, request: HttpRequestData, caller: SecurityContext | undefined, path: IngressPath): HttpStreamResponse | undefined {
    const size = bodyBytes(request.body);
    if (size <= this.maxBodyBytes) return undefined;
    this.options.telemetry?.report('ingress.body_too_large', caller, { path, port, method: String(request.method).slice(0, 16), bytes: size, limit: this.maxBodyBytes });
    return textResponse(413, `Request body of ${size} bytes is over the runtime's ${this.maxBodyBytes}-byte limit.`);
  }
}
