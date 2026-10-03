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
/** worker → pages: "I lost the port for `id` (I was restarted) — attach again". */
export const REATTACH = 'bfwc:reattach';

/**
 * The cross-origin relay (`relay.html`, served on the preview origin and framed,
 * hidden, by the host). The host cannot talk to a worker on another origin, so the
 * relay registers it and passes messages both ways.
 */
/** relay → host: the worker is active; send ports. */
export const RELAY_READY = 'bfwc:relay-ready';
/** host → relay, with a MessagePort: forward as ATTACH for `id`. */
export const RELAY_ATTACH = 'bfwc:relay-attach';
/** relay → host: the worker asked for `id` again. */
export const RELAY_REATTACH = 'bfwc:relay-reattach';
/** host → relay: reload every frame showing the preview at `base`. */
export const RELAY_RELOAD = 'bfwc:relay-reload';

export interface AttachMessage {
  type: typeof ATTACH;
  id: string;
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
}

export interface WireResponse {
  type: 'response';
  reqId: number;
  status: number;
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

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
