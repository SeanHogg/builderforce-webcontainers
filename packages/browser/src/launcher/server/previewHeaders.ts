/**
 * The response headers of the launcher's origins. The preview origins' sets come from
 * the package's ONE owner of them (`../../previewHeaders.ts`, also what the Builderforce
 * API serves), under the launcher's profile — two local differences, both stricter or
 * equal:
 *
 * - no `report-to` / `Reporting-Endpoints`: there is no report endpoint on a laptop
 *   (and the runtime drops a report URL that is not https anyway);
 * - no signed egress policies: every process Worker gets the most restrictive policy
 *   (the default connect sources only), and `sw.js` is served only with no `policy`,
 *   no `report`, no `csp`, no repeated key and egress within the runtime's own package CDN.
 *
 * `frame-ancestors` on every preview response is the host page's origin only.
 * Pure: strings in, header records out.
 */
import { PREVIEW_DEFAULT_EGRESS, previewHeaders, type HeaderSet } from '../../previewHeaders.js';
import { repeatsAKey } from '../../swBindings.js';

export { PREVIEW_WORKER_SCRIPTS, type HeaderSet, type PreviewScript } from '../../previewHeaders.js';

/** The launcher's profile: no embedding headers, no reporting, Worker scripts re-checked on every load (a later launch on the same port may serve another package version). */
const LAUNCHER = previewHeaders({ scriptType: 'text/javascript; charset=utf-8', workerScriptCache: 'no-cache' });

/**
 * The CDNs the host page itself loads from: esbuild-wasm (jsdelivr), the component/style
 * compilers (esm.sh, the default package CDN — spelled once, in `PREVIEW_DEFAULT_EGRESS`;
 * this Node module does not load core for its `ESM_SH_ORIGIN`).
 */
const PAGE_CDN_SOURCES: readonly string[] = ['https://cdn.jsdelivr.net', ...PREVIEW_DEFAULT_EGRESS];

const NOSNIFF = { 'X-Content-Type-Options': 'nosniff' } as const;
const directive = (name: string, ...sources: readonly string[]) => [name, ...sources].join(' ');

/** `relay.html`: framed only by the host page, starts Workers only from its own origin, connects nowhere. */
export const relayHeaders = (frameAncestors: readonly string[]): HeaderSet => LAUNCHER.relay(frameAncestors);

/** `sw.js`: imports nothing, fetches only its own origin; browsers re-check it on navigation. */
export const serviceWorkerHeaders = (): HeaderSet => LAUNCHER.serviceWorker();

/**
 * A process Worker script: the default egress only (no signed policies locally).
 * `ownPaths`: path-scoped loopback sources it must load (the .NET bundle) — never a
 * bare origin, which would let it re-enter `/__bfwc/` as preview ingress.
 */
export const workerScriptHeaders = (ownPaths: readonly string[] = []): HeaderSet => LAUNCHER.workerScript(ownPaths);

/** Every other response a preview origin answers (404s, a refusal, the .NET bundle), on `host` (`name:port`). */
export const previewDocumentHeaders = (host: string, frameAncestors: readonly string[]): HeaderSet => LAUNCHER.document(host, frameAncestors);

/** The only query keys a local `sw.js` URL may carry: no `policy` (none is signed locally), no `report`, never `csp`. */
const SERVICE_WORKER_KEYS: ReadonlySet<string> = new Set(['mode', 'egress']);

/**
 * Whether `sw.js` may be served for this URL: `mode=relay` (any other mode takes
 * attaches from any page on the origin), egress within {@link PREVIEW_DEFAULT_EGRESS},
 * and no other key. An allowlist: preview code is same-origin with `sw.js` and can
 * re-register it with any query, and the launcher never runs report-only, so a
 * `csp=report-only` (which would turn the preview's whole CSP report-only), a
 * `policy`, a `report` or any key this gate does not know is refused. So is any key
 * named twice: the gate and the worker must read the same single value.
 */
export function serviceWorkerAllowed(url: URL): boolean {
  const params = url.searchParams;
  if (repeatsAKey(params)) return false;
  for (const key of params.keys()) if (!SERVICE_WORKER_KEYS.has(key)) return false;
  if (params.get('mode') !== 'relay') return false;
  const egress = (params.get('egress') ?? '').split(' ').filter(Boolean).map((source) => source.toLowerCase());
  return egress.every((source) => PREVIEW_DEFAULT_EGRESS.includes(source));
}

/**
 * The host page's own documents and scripts. It runs no project code (that is on the
 * preview origins), but it holds the launch token, so it frames only the preview
 * origins, loads scripts only from itself and the runtime's CDNs, connects only to
 * itself, the CDNs and the preview origins' probe (`probeSources`: exact paths), and is
 * framed by nobody.
 */
export function pageHeaders(contentType: string, relayOrigin: string, appOriginPattern: string, probeSources: readonly string[] = []): HeaderSet {
  return {
    'Content-Type': contentType,
    'Content-Security-Policy': [
      directive('default-src', "'self'"),
      directive('script-src', "'self'", "'wasm-unsafe-eval'", ...PAGE_CDN_SOURCES),
      directive('worker-src', "'self'", 'blob:'),
      directive('connect-src', "'self'", ...PAGE_CDN_SOURCES, ...probeSources),
      directive('frame-src', relayOrigin, appOriginPattern),
      directive('img-src', "'self'", 'data:', 'blob:'),
      directive('style-src', "'self'"),
      directive('object-src', "'none'"),
      directive('base-uri', "'none'"),
      directive('form-action', "'none'"),
      directive('frame-ancestors', "'none'"),
    ].join('; '),
    ...NOSNIFF,
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

/** A `/__bf/*` answer: never cached, never sniffed, never framed. */
export function apiHeaders(contentType: string): HeaderSet {
  return { 'Content-Type': contentType, ...NOSNIFF, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
}

/** The probe a preview origin answers the host page (`allowedOrigin`) with: empty, readable cross-origin by that page only. */
export function probeHeaders(allowedOrigin: string): HeaderSet {
  return { ...NOSNIFF, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
}
