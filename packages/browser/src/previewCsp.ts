/**
 * What the preview service worker stamps on EVERY response it serves (make.md ›
 * PRD 31 §4 W10, controls 1 and 6, preview side). Pure: the worker and the
 * tests share it.
 *
 * - The Content-Security-Policy, whatever the response's Content-Type (or none):
 *   CSP is inert on a non-document, so stamping everything costs nothing and
 *   covers what a type check misses — a missing type, SVG, XHTML, a sniffed
 *   body. Its sources are the preview's own origin, `blob:`/`data:` where a
 *   directive needs them, and the egress the HOST configured for this origin
 *   (`relayConfig`) — never anything a preview or an attach message says.
 * - `X-Content-Type-Options: nosniff`, so a body is never run as a type it was
 *   not served as.
 * - `Origin-Agent-Cluster: ?1`: same-site sibling preview origins
 *   (`a.preview.example.com`, `b.preview.example.com`) never share an agent
 *   cluster, so `document.domain` cannot join them.
 * - A `Set-Cookie` `Domain=` broader than the preview's exact host is removed
 *   (the cookie stays host-only), so one application cannot set a cookie its
 *   same-site siblings receive. (Browsers drop `Set-Cookie` on responses a
 *   service worker builds anyway; this holds if one ever passes it on.)
 *
 * The policy is ADDED as a further policy, never merged into or replacing the
 * app's own: browsers enforce every policy a response carries, so the result is
 * at least as strict as each — the app's stricter CSP survives, ours always applies.
 */
import { headerKeys, withoutHeader } from './shared/headers.js';

/** An egress source the host may declare: an https or wss origin, optionally `*.`-wildcarded, no path. */
const EGRESS_SOURCE = /^(?:https|wss):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/** At most this many egress sources per preview; the rest are dropped (never widened to a wildcard). */
export const MAX_EGRESS = 64;

/** Whether `entry` is an egress source the host may declare (see {@link egressSources}). */
export const isEgressSource = (entry: unknown): entry is string => typeof entry === 'string' && EGRESS_SOURCE.test(entry);

/** A host (`name[:port]`) the policy may name for the preview's own WebSockets. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

/** The Reporting API group the policy's `report-to` names (`Reporting-Endpoints: bfwc-csp="<url>"`). */
export const CSP_REPORT_GROUP = 'bfwc-csp';

/** The well-formed egress sources in `egress`, deduplicated and lowercased; anything else (paths, keywords, quotes, `;`) is dropped. */
export function egressSources(egress: unknown): string[] {
  if (!Array.isArray(egress)) return [];
  const sources = new Set<string>();
  for (const entry of egress) {
    if (isEgressSource(entry)) sources.add(entry.toLowerCase());
    if (sources.size >= MAX_EGRESS) break;
  }
  return [...sources];
}

/** `value` when it is an absolute https URL that can sit in a header unquoted-safe (no quote, comma, semicolon or space); else undefined. */
export function cspReportUrlOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || /["',;\s\\]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface PreviewPolicyOptions {
  /** The preview's own host (`key.preview.example.com[:port]`): its `ws:`/`wss:` are allowed explicitly (dev servers' HMR), not left to how a browser reads `'self'`. */
  host?: string;
  /** Add `report-to <CSP_REPORT_GROUP>` (only with a `Reporting-Endpoints` header naming it: see `stampPreviewResponse`). */
  report?: boolean;
}

/**
 * The policy preview responses get, for the host-configured `egress`. `style-src`,
 * `font-src` and `media-src` are spelled out so `default-src` does not refuse the
 * inline styles every framework injects.
 */
export function previewDocumentPolicy(egress: unknown, options: PreviewPolicyOptions = {}): string {
  const out = egressSources(egress);
  const sockets = options.host && HOST.test(options.host) ? [`ws://${options.host.toLowerCase()}`, `wss://${options.host.toLowerCase()}`] : [];
  const directive = (name: string, ...sources: string[]) => [name, ...sources].join(' ');
  return [
    directive('default-src', "'self'", ...out),
    directive('script-src', "'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:', ...out),
    directive('style-src', "'self'", "'unsafe-inline'", 'blob:', 'data:', ...out),
    directive('img-src', "'self'", 'data:', 'blob:', ...out),
    directive('font-src', "'self'", 'data:', ...out),
    directive('media-src', "'self'", 'data:', 'blob:', ...out),
    directive('connect-src', "'self'", ...sockets, 'blob:', 'data:', ...out),
    directive('frame-src', "'self'", 'blob:'),
    directive('form-action', "'self'", ...out),
    directive('worker-src', "'self'", 'blob:'),
    ...(options.report ? [directive('report-to', CSP_REPORT_GROUP)] : []),
  ].join('; ');
}

/** What the worker stamps: the policy, where its violations are reported, and the preview's exact host. */
export interface PreviewStamp {
  policy: string;
  /** `cspReportUrlOf`-checked; with it, `Reporting-Endpoints` names `CSP_REPORT_GROUP`. */
  reportUrl?: string;
  /** The preview origin's hostname: a cookie `Domain=` other than it is removed. */
  host?: string;
  /**
   * Stamp `policy` as `Content-Security-Policy-Report-Only` (the host's
   * `previewCspMode: 'report-only'`, migrations only): violations are reported,
   * nothing is blocked. The app's own policies are left as they are either way.
   */
  reportOnly?: boolean;
}

/** `setCookie` with every `Domain=` attribute that is not exactly `host` removed (no host: every one). */
export function narrowCookieDomain(setCookie: string, host: string | undefined): string {
  return setCookie.replace(/;\s*domain\s*=\s*([^;,]*)/gi, (attribute, value: string) =>
    host !== undefined && value.trim().replace(/^\./, '').toLowerCase() === host.toLowerCase() ? attribute : '',
  );
}

/** Join every spelling of `name` in `headers` into one value (`, `-separated, as HTTP folds them). */
function joined(headers: Record<string, string>, name: string): string {
  return headerKeys(headers, name)
    .map((key) => headers[key]!.trim())
    .filter(Boolean)
    .join(', ');
}

/** `headers` stamped (see the file comment). Duplicate spellings of a header are folded into one lowercase key. */
export function stampPreviewResponse(headers: Record<string, string>, stamp: PreviewStamp): Record<string, string> {
  // Ours goes into the enforced header, or (report-only mode) the report-only one; the app's stay where it put them.
  const cspHeader = stamp.reportOnly ? 'content-security-policy-report-only' : 'content-security-policy';
  const existingCsp = joined(headers, cspHeader);
  const existingEndpoints = joined(headers, 'reporting-endpoints');
  const cookies = joined(headers, 'set-cookie');
  let out = headers;
  for (const name of [cspHeader, 'x-content-type-options', 'origin-agent-cluster', 'reporting-endpoints', 'set-cookie']) out = withoutHeader(out, name);
  // A comma separates policies in one header value: each is enforced (or reported) on its own.
  out[cspHeader] = existingCsp ? `${existingCsp}, ${stamp.policy}` : stamp.policy;
  out['x-content-type-options'] = 'nosniff';
  out['origin-agent-cluster'] = '?1';
  if (stamp.reportUrl) {
    const ours = `${CSP_REPORT_GROUP}="${stamp.reportUrl}"`;
    out['reporting-endpoints'] = existingEndpoints ? `${existingEndpoints}, ${ours}` : ours;
  } else if (existingEndpoints) out['reporting-endpoints'] = existingEndpoints;
  if (cookies) out['set-cookie'] = narrowCookieDomain(cookies, stamp.host);
  return out;
}
