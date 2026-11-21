/**
 * The page end of the runtime's diagnostics: a script every preview page runs
 * (beside the error bridge) that tells the host page
 *
 *   • what the page's Content-Security-Policy blocked (`securitypolicyviolation`):
 *     the effective directive and the blocked ORIGIN only — a URL is reduced to
 *     its origin, a non-URL to its keyword (`inline`, `eval`, `data`, `blob`), so
 *     no path or query ever leaves the page. Each (directive, origin) is posted
 *     once per page load, at most {@link CSP_VIOLATION_LIMIT} per page;
 *   • how the page's own requests went (`PerformanceResourceTiming`): origin,
 *     initiator type, duration, status and whether a cache answered — never the
 *     URL — batched, at most {@link TIMING_ENTRY_LIMIT} per page load;
 *   • when it first painted (`first-contentful-paint`);
 *   • which of those it could not measure (no `PerformanceObserver`, or an entry
 *     type the engine refuses): `{ kind: 'unavailable', feature }`, see
 *     {@link PREVIEW_TIMING_FEATURES}.
 *
 * Everything posted comes from the preview, which runs the app's code: the host
 * treats it as diagnostics only, never as a security signal.
 */
import { scriptLiteral } from './previewBridge.js';

/** page → host: one CSP violation `{ directive, blockedOrigin, disposition }`. */
export const CSP_VIOLATION_MESSAGE_TYPE = 'bfwc:csp-violation';
/** page → host: a batch of timings `{ entries: PreviewTimingEntry[] }`. */
export const TIMING_MESSAGE_TYPE = 'bfwc:timing';
/** Distinct CSP violations forwarded per page load; past this the page goes quiet. */
export const CSP_VIOLATION_LIMIT = 50;
/** Resource timings forwarded per page load. */
export const TIMING_ENTRY_LIMIT = 2000;
/** Entries per timing message. */
export const TIMING_BATCH_SIZE = 100;
/**
 * The measurements a page reports it could not take (a timing entry
 * `{ kind: 'unavailable', feature }`): its resource timings, its paint timing.
 */
export const PREVIEW_TIMING_FEATURES = { resource: 'resourceTiming', paint: 'paintTiming' } as const;
/** How long the page gathers timings before posting a batch. */
const TIMING_FLUSH_MS = 1000;

/** A keyword `blockedURI` (`inline`, `eval`, `wasm-eval`, `trusted-types-sink`, `data`, `blob`). */
const KEYWORD = /^[a-z][a-z-]{0,39}$/i;

/**
 * What a CSP violation's `blockedURI` is reduced to: an http(s)/ws(s) URL's origin,
 * another URL's scheme (`data`, `blob`), a keyword as given (lowercased); undefined
 * for anything else. The page script applies the same rule; the host applies it again.
 */
export function cspBlockedOrigin(blocked: unknown): string | undefined {
  if (typeof blocked !== 'string' || !blocked) return undefined;
  if (KEYWORD.test(blocked)) return blocked.toLowerCase();
  let url: URL;
  try {
    url = new URL(blocked);
  } catch {
    return undefined;
  }
  if (/^(https?|wss?):$/.test(url.protocol)) return url.origin;
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  return KEYWORD.test(scheme) ? scheme : undefined;
}

/** The diagnostics script (see the module doc). `nonce`: the runtime's, carried by every message. */
export function previewDiagnosticsScript(nonce = ''): string {
  return `<script>(function(){
  if (window.__bfwcDiagnostics) return;
  window.__bfwcDiagnostics = true;
  var NONCE = ${scriptLiteral(nonce)};
  // Taken now, before the app's code runs: a later reassignment of these globals cannot redirect or stall the reports.
  var host = parent, setTimer = setTimeout, clearTimer = clearTimeout;
  var post = function (message) {
    message.href = location.href;
    message.nonce = NONCE;
    try { host.postMessage(message, '*'); } catch (_) {}
  };
  var KEYWORD = ${KEYWORD};
  function blockedOrigin(b) {
    b = typeof b === 'string' ? b : '';
    if (!b) return null;
    if (KEYWORD.test(b)) return b.toLowerCase();
    var u;
    try { u = new URL(b); } catch (_) { return null; }
    if (/^(https?|wss?):$/.test(u.protocol)) return u.origin;
    var scheme = u.protocol.slice(0, -1).toLowerCase();
    return KEYWORD.test(scheme) ? scheme : null;
  }
  var seen = {}, violations = 0;
  addEventListener('securitypolicyviolation', function (e) {
    if (violations >= ${CSP_VIOLATION_LIMIT}) return;
    var directive = String(e.effectiveDirective || e.violatedDirective || '').split(' ')[0].toLowerCase();
    var origin = blockedOrigin(e.blockedURI);
    if (!/^[a-z-]{1,40}$/.test(directive) || !origin) return;
    var key = directive + ' ' + origin;
    if (seen[key]) return;
    seen[key] = true;
    violations++;
    post({ type: ${JSON.stringify(CSP_VIOLATION_MESSAGE_TYPE)}, directive: directive, blockedOrigin: origin, disposition: e.disposition === 'report' ? 'report' : 'enforce' });
  });
  var queue = [], total = 0, timer = 0;
  function flush() {
    if (timer) clearTimer(timer);
    timer = 0;
    while (queue.length) post({ type: ${JSON.stringify(TIMING_MESSAGE_TYPE)}, entries: queue.splice(0, ${TIMING_BATCH_SIZE}) });
  }
  function push(entry) {
    queue.push(entry);
    if (!timer) timer = setTimer(flush, ${TIMING_FLUSH_MS});
  }
  // A measurement this page cannot take is reported as such, never silently left out.
  function unavailable(feature) { push({ kind: 'unavailable', feature: feature }); }
  if (typeof PerformanceObserver === 'undefined' || typeof performance === 'undefined') {
    unavailable(${JSON.stringify(PREVIEW_TIMING_FEATURES.resource)});
    unavailable(${JSON.stringify(PREVIEW_TIMING_FEATURES.paint)});
    return;
  }
  function resource(e) {
    if (total >= ${TIMING_ENTRY_LIMIT}) return;
    var origin;
    try { origin = new URL(e.name).origin; } catch (_) { return; }
    if (!/^https?:/.test(origin)) return;
    total++;
    var size = e.decodedBodySize || 0;
    push({ kind: 'resource', origin: origin, initiator: String(e.initiatorType || 'other').slice(0, 32), durationMs: Math.round(e.duration || 0), status: e.responseStatus || 0, cached: size > 0 ? (e.deliveryType === 'cache' || e.transferSize === 0) : null });
  }
  function paint(e) {
    if (e.name === 'first-contentful-paint') push({ kind: 'paint', startMs: Math.round(e.startTime), at: Math.round(performance.timeOrigin + e.startTime) });
  }
  // An entry type the engine does not support is ignored by observe() without a throw: supportedEntryTypes says so up front.
  var supported = PerformanceObserver.supportedEntryTypes;
  function observe(type, each, feature) {
    if (supported && supported.indexOf(type) < 0) return unavailable(feature);
    try { new PerformanceObserver(function (list) { list.getEntries().forEach(each); }).observe({ type: type, buffered: true }); } catch (_) { unavailable(feature); }
  }
  observe('resource', resource, ${JSON.stringify(PREVIEW_TIMING_FEATURES.resource)});
  observe('paint', paint, ${JSON.stringify(PREVIEW_TIMING_FEATURES.paint)});
  addEventListener('pagehide', flush);
})();</script>`;
}
