/**
 * The wire between the host page (which owns the file system and the dev server)
 * and the service worker (which owns the network). The worker holds no project
 * state: every request it intercepts is forwarded over a MessagePort to the page.
 */

export const PREVIEW_SEGMENT = '__bfwc';

/**
 * What a preview id may contain. No dots, so a file served beside the worker
 * (`sw.js`, `relay.html`) can never be mistaken for a preview.
 */
export const PREVIEW_ID = /^[A-Za-z0-9_-]+$/;

/** page → worker, with a MessagePort in `ports[0]`: "serve preview `id` over this port". */
export const ATTACH = 'bfwc:attach';
/** worker → pages: "attach `id` again" — I was restarted and lost its port, or its last attach presented a stale nonce. */
export const REATTACH = 'bfwc:reattach';

/**
 * The cross-origin relay (`relay.html`, served on the preview origin and framed,
 * hidden, by the host). The host cannot talk to a worker on another origin, so the
 * relay registers it and passes messages both ways.
 */
/** relay → host: the worker is active; send ports. */
export const RELAY_READY = 'bfwc:relay-ready';
/** host → relay, with a MessagePort: forward as ATTACH for `id`, with its `nonce` and `previous` (`AttachProof`) and nothing else. */
export const RELAY_ATTACH = 'bfwc:relay-attach';
/** relay → host: the worker asked for `id` again. */
export const RELAY_REATTACH = 'bfwc:relay-reattach';
/** host → relay: tell every frame showing the preview at `base` what changed (`update`; absent = reload). */
export const RELAY_UPDATE = 'bfwc:relay-reload';
/** host → relay, with a MessagePort: start a process worker on the preview origin, bridged over the port. */
export const RELAY_SPAWN = 'bfwc:relay-spawn';

/**
 * What an attach proves (W10 control 2): `nonce` is fresh for this attach, minted
 * by the host page; `previous` is the nonce of the host's last attach of the same
 * id that the worker acknowledged (`WireAttached`). The worker binds the nonce to
 * the attaching client, and a later attach of that id from that client must
 * present it as `previous` — so a script that can post as the relay client but
 * never saw the host's messages cannot rebind it. A stale `previous` from the
 * bound client makes the worker ask for a fresh attach (never a lockout). Both
 * travel only by postMessage to the exact relay origin and the worker, never in
 * a URL a preview can read. Within one application's origin this is defence in
 * depth: the boundary is the application's origin (control 1).
 */
export interface AttachProof {
  nonce: string;
  previous?: string;
}

/** 128 random bits, lowercase hex: an attach nonce. */
export const ATTACH_NONCE = /^[0-9a-f]{32}$/;

/** 128 random bits from the platform CSPRNG, hex (attach nonces and the preview-message nonce). */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The proof carried by an attach message, or null when it carries none that is well-formed. */
export function attachProofOf(message: { nonce?: unknown; previous?: unknown } | null | undefined): AttachProof | null {
  if (!message || typeof message.nonce !== 'string' || !ATTACH_NONCE.test(message.nonce)) return null;
  if (message.previous === undefined) return { nonce: message.nonce };
  return typeof message.previous === 'string' && ATTACH_NONCE.test(message.previous) ? { nonce: message.nonce, previous: message.previous } : null;
}

/**
 * page → worker. Carries the id and its proof only: the worker's egress is
 * host-side configuration in its own script URL (`relayConfig`), never anything
 * an attach says — a preview that scripts the relay can post one.
 */
export interface AttachMessage extends AttachProof {
  type: typeof ATTACH;
  id: string;
}

/** The ATTACH message for `id` with `proof`, built from exactly those fields (whatever else `data` carries is dropped). */
export function attachMessageOf(data: { id: string; nonce?: unknown; previous?: unknown }): AttachMessage {
  const message: AttachMessage = { type: ATTACH, id: data.id, nonce: data.nonce as string };
  if (data.previous !== undefined) message.previous = data.previous as string;
  return message;
}

/**
 * worker → page, on the attached port: the worker accepted the attach with
 * `nonce` and bound it. The page advances its nonce chain (`previous`) only on
 * this, so an attach the worker never saw cannot desync the chain.
 */
export interface WireAttached {
  type: 'attached';
  nonce: string;
}

export function isWireAttached(value: unknown): value is WireAttached {
  const v = value as WireAttached | null;
  return !!v && v.type === 'attached' && typeof v.nonce === 'string';
}

export interface ReattachMessage {
  type: typeof REATTACH;
  id: string;
}

export interface WireRequest {
  type: 'request';
  reqId: number;
  path: string;
  search: string;
  /** Present for requests to a virtual Node server (`/__port/<n>/…`), which see the full request. */
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer | null;
  /** A port request a preview page made (never a navigation, never the host's): see {@link RequestOrigin}. */
  from?: RequestOrigin;
}

/**
 * Which preview page made a port request, as the worker knows it from its own
 * client bindings (never from the request): `port`, the virtual server that
 * served the page (absent for a dev-server document); `ingress`, the worker
 * routed it by the application's ingress table (it was a path outside the
 * preview prefix). The host decides who the page acts as from this.
 */
export interface RequestOrigin {
  port?: number;
  ingress?: true;
}

/** One ingress route as the worker applies it: a path prefix (no trailing `/`, `/` the catch-all) and the port that serves it. */
export interface WireIngressRoute {
  path: string;
  port: number;
}

/**
 * page → worker, on the attached port, after every attach and whenever it
 * changes: the ingress table of the application this origin serves (empty:
 * none). Only the host holds the other end of that port, so a preview can
 * never set it.
 */
export interface WireIngress {
  type: 'ingress';
  routes: WireIngressRoute[];
}

/** The routes of a well-formed ingress message (bad entries dropped), longest path first; null for anything else. */
export function ingressRoutesOf(value: unknown): WireIngressRoute[] | null {
  const v = value as WireIngress | null;
  if (!v || v.type !== 'ingress' || !Array.isArray(v.routes)) return null;
  return v.routes
    .filter((route): route is WireIngressRoute => !!route && typeof route.path === 'string' && route.path.startsWith('/') && Number.isInteger(route.port) && route.port > 0 && route.port < 65536)
    .map((route) => ({ path: route.path, port: route.port }))
    .sort((a, b) => b.path.length - a.path.length);
}

/** The route for `pathname`: the longest whose path is it or a whole-segment prefix of it (`/api` takes `/api/x`, never `/apix`). */
export function matchIngressRoute(routes: readonly WireIngressRoute[], pathname: string): WireIngressRoute | undefined {
  return routes.find((route) => route.path === '/' || pathname === route.path || pathname.startsWith(route.path + '/'));
}

/** The path segment that routes a preview request to a virtual server: `/__port/3000/…`. */
export const PORT_SEGMENT = '__port';

export function isPortPath(path: string): boolean {
  return path.startsWith(`/${PORT_SEGMENT}/`);
}

export interface WireResponse {
  type: 'response';
  reqId: number;
  status: number;
  headers: Record<string, string>;
  /** The whole body — or, with `streaming`, null: the body follows as `chunk` messages until `end`. */
  body: string | ArrayBuffer | null;
  streaming?: boolean;
}

/** page → worker: the next piece of a streaming response's body. */
export interface WireChunk {
  type: 'chunk';
  reqId: number;
  data: ArrayBuffer;
}

/** page → worker: a streaming response is complete (`error`: it broke off, e.g. the server process exited). */
export interface WireEnd {
  type: 'end';
  reqId: number;
  error?: string;
}

/** worker → page: the preview stopped reading a streaming response (closed an EventSource, navigated away). */
export interface WireCancel {
  type: 'cancel';
  reqId: number;
}

export type WireReply = WireResponse | WireChunk | WireEnd;

/**
 * The URL prefix previews live under, for a worker scope. Serving the worker from
 * `/__bfwc/sw.js` (scope `/__bfwc/`) keeps it off every other page of the host app;
 * a root-scoped worker still only answers under `/__bfwc/`.
 */
export function previewPrefix(scopePath: string): string {
  const scope = scopePath.endsWith('/') ? scopePath : scopePath + '/';
  return scope.endsWith(`/${PREVIEW_SEGMENT}/`) ? scope : `${scope}${PREVIEW_SEGMENT}/`;
}

export function previewBase(scopePath: string, id: string): string {
  return `${previewPrefix(scopePath)}${id}/`;
}

export function isWireRequest(value: unknown): value is WireRequest {
  const v = value as WireRequest | null;
  return !!v && v.type === 'request' && typeof v.reqId === 'number' && typeof v.path === 'string';
}

export function isWireResponse(value: unknown): value is WireResponse {
  const v = value as WireResponse | null;
  return !!v && v.type === 'response' && typeof v.reqId === 'number';
}

export function isWireReply(value: unknown): value is WireReply {
  const v = value as WireReply | null;
  return !!v && (v.type === 'response' || v.type === 'chunk' || v.type === 'end') && typeof v.reqId === 'number';
}

export function isWireCancel(value: unknown): value is WireCancel {
  const v = value as WireCancel | null;
  return !!v && v.type === 'cancel' && typeof v.reqId === 'number';
}
