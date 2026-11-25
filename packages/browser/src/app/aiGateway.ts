/**
 * Page-side HTTP gateway for an `ai` resource (contract §5).
 *
 * The process dials `AI_BASE_URL` (`http://localhost:<port>/v1`) on the port
 * registry. This module is the only caller of `HostRelay.forwardAi`. The port
 * is never registered as ingress and never announced on a preview origin: it
 * is a virtual listen owned by the backend service that `uses` the resource,
 * so the existing port policy admits that service and refuses every other
 * service (the same shape as `mayConnectToDatabase`, on `resourceUses`).
 *
 * Request `Authorization` is dropped before the relay call — `forwardAi` has
 * no header channel. Response `Set-Cookie`, `Authorization` and
 * `WWW-Authenticate` are never written on the process response. The completion
 * is streamed; it is not buffered.
 */
import type { SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { HttpHandler, HttpRequestData, HttpStreamResponse } from '@seanhogg/builderforce-webcontainers-core';
import { receivesDatabaseCredentials } from '@seanhogg/builderforce-webcontainers-core/app';
import type { AiForwardRequest, HostRelay } from './hostRelay.js';

/** Headers that must never be written back to the process (contract §5). */
export const STRIPPED_RESPONSE_HEADERS = ['set-cookie', 'authorization', 'www-authenticate'] as const;

/** The process path under the base URL (`AI_BASE_URL` + `/chat/completions`). */
export const AI_COMPLETIONS_PATH = '/v1/chat/completions';

export interface AiGatewayListen {
  /**
   * Register an HTTP handler on the runtime's port registry. Port 0 picks a
   * free port. `owner` is the backend service the port is attributed to — the
   * port policy then admits only that service (and platform/workspace). The
   * listener must not announce the port on a preview origin.
   */
  listen(port: number, handler: HttpHandler, owner?: SecurityContext): { port: number; close(): void };
}

export interface AiGatewayResource {
  resourceId: string;
  /** Host-read allowlist. Absent: forward and let the API router decide. */
  models?: readonly string[];
}

export interface AiGatewayBinding {
  readonly serviceId: string;
  readonly resourceId: string;
  readonly port: number;
  /** `http://localhost:<port>/v1` — no trailing slash; the app appends `/chat/completions`. */
  readonly baseUrl: string;
  close(): void;
}

export interface AiGateway {
  readonly bindings: readonly AiGatewayBinding[];
  /** Base URL for this backend + resource, or undefined when it has no gateway. */
  baseUrl(serviceId: string, resourceId: string): string | undefined;
  close(): void;
}

export interface StartAiGatewayOptions {
  applicationId: string;
  /** Backend services only; a frontend never gets a port. */
  services: readonly ServiceSpec[];
  relay: HostRelay;
  listen: AiGatewayListen['listen'];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function headerMap(headers: HttpRequestData['headers']): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => map.set(key.toLowerCase(), value));
    return map;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) map.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    return map;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    map.set(key.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
  return map;
}

/** Drop every stripped name. Used by the gateway and by adapters before they yield. */
export function withoutSecretHeaders(headers: Iterable<[string, string]>): [string, string][] {
  const banned = new Set<string>(STRIPPED_RESPONSE_HEADERS);
  return [...headers].filter(([name]) => !banned.has(name.toLowerCase()));
}

function jsonResponse(status: number, message: string): HttpStreamResponse {
  const body = textEncoder.encode(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': String(body.byteLength) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
  };
}

function requestedModel(body: Uint8Array): string | undefined {
  try {
    const parsed = JSON.parse(textDecoder.decode(body)) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reject a `model` outside the host-read allowlist. Absent allowlist: do not
 * decide — the API gateway's cascade router does. The allowlist argument is
 * the one the host read; callers must not pass process-supplied bytes here.
 */
export function modelAllowed(body: Uint8Array, allowlist: readonly string[] | undefined): { ok: true } | { ok: false; message: string } {
  if (!allowlist || allowlist.length === 0) return { ok: true };
  const model = requestedModel(body);
  if (!model) return { ok: false, message: 'model is required by this resource allowlist' };
  if (!allowlist.includes(model)) return { ok: false, message: `model "${model}" is not allowed for this resource` };
  return { ok: true };
}

function wantsStream(body: Uint8Array, headers: Map<string, string>): boolean {
  if (headers.get('accept')?.includes('text/event-stream')) return true;
  try {
    const parsed = JSON.parse(textDecoder.decode(body)) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

/** Stream `iterator` without buffering the completion; `first` is a chunk already pulled from it. */
export function streamBytes(iterator: AsyncIterator<Uint8Array>, first?: IteratorResult<Uint8Array>): ReadableStream<Uint8Array> {
  let pending = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = pending ?? (await iterator.next());
        pending = undefined;
        if (next.done) {
          controller.close();
          return;
        }
        if (next.value.byteLength) controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/**
 * The HTTP handler for one backend's gateway port. `models` is the host-read
 * allowlist. Process `Authorization` is read only to drop it — it is not
 * copied onto {@link AiForwardRequest}.
 */
export function aiGatewayHandler(relay: HostRelay, resource: AiGatewayResource): HttpHandler {
  return async (request) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (request.method !== 'POST' || (path !== AI_COMPLETIONS_PATH && path !== '/chat/completions')) {
      return jsonResponse(404, 'Not found');
    }
    const headers = headerMap(request.headers);
    // Drop the process Authorization. It is not forwarded (no header field on the relay request).
    headers.delete('authorization');
    const body = request.body ?? new Uint8Array();
    const allowed = modelAllowed(body, resource.models);
    if (!allowed.ok) return jsonResponse(400, allowed.message);
    const forward: AiForwardRequest = {
      resourceId: resource.resourceId,
      ...(resource.models && resource.models.length > 0 ? { models: resource.models } : {}),
      body,
      stream: wantsStream(body, headers),
    };
    // The first chunk is pulled before the head is written, so a relay that fails early answers 502.
    let iterator: AsyncIterator<Uint8Array>;
    let first: IteratorResult<Uint8Array>;
    try {
      iterator = relay.forwardAi(forward)[Symbol.asyncIterator]();
      first = await iterator.next();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI relay failed';
      return jsonResponse(502, message);
    }
    return {
      status: 200,
      // Built here, never copied from the upstream. Secret headers cannot appear.
      headers: {
        'content-type': forward.stream ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-cache',
      },
      body: streamBytes(iterator, first),
    };
  };
}

/** The same predicate `serviceEnv` uses for credentials, so env and bindings cannot disagree. */
const isBackend = receivesDatabaseCredentials;

/**
 * Register one gateway port per backend `ai` use, before services start.
 * A frontend use gets nothing. The port is not an ingress route.
 */
export function startAiGateway(options: StartAiGatewayOptions): AiGateway {
  const bindings: AiGatewayBinding[] = [];
  const byKey = new Map<string, AiGatewayBinding>();
  for (const service of options.services) {
    if (!isBackend(service)) continue;
    for (const use of service.resourceUses ?? []) {
      if (use.type !== 'ai') continue;
      const resource: AiGatewayResource = {
        resourceId: use.id,
        ...(use.models && use.models.length > 0 ? { models: use.models } : {}),
      };
      const owner: SecurityContext = { applicationId: options.applicationId, serviceId: service.id };
      const registration = options.listen(0, aiGatewayHandler(options.relay, resource), owner);
      const binding: AiGatewayBinding = {
        serviceId: service.id,
        resourceId: use.id,
        port: registration.port,
        baseUrl: `http://localhost:${registration.port}/v1`,
        close: () => registration.close(),
      };
      bindings.push(binding);
      byKey.set(`${service.id}\0${use.id}`, binding);
    }
  }
  return {
    bindings,
    baseUrl: (serviceId, resourceId) => byKey.get(`${serviceId}\0${resourceId}`)?.baseUrl,
    close() {
      for (const binding of bindings) binding.close();
    },
  };
}
