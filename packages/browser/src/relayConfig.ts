/**
 * The host-side configuration of a preview origin's service worker (make.md ›
 * PRD 31 §4 W10, control 1 "attach takes no egress"): which external sources
 * its responses' CSP allows, where violations are reported, and the signed
 * policy id that vouches for both.
 *
 * WHY THE SCRIPT URL. Everything a preview origin's service worker is told by
 * message can be forged: the preview runs the app's code on the same origin as
 * the relay frame, so it can script the relay (`parent.frames[i]`) and post to
 * the worker as it. The worker's own script URL cannot be changed by message.
 * The host bakes this configuration into the relay URL it frames; the relay
 * copies it into the worker URL it registers (`sw.js?mode=relay&…`); the worker
 * reads it once from `self.location`. Changing it takes a new registration,
 * which the browser fetches from the embedder's server — and preview code CAN
 * attempt one with any query (it is same-origin with `sw.js`). So the embedder's
 * server gate is the enforcement (README › Preview origin headers): it serves
 * `sw.js` only when `policy` verifies for that origin and `egress`/`report` are
 * within what that policy grants, refuses every query key it does not check and
 * any key named twice (`relayConfigOf` reads such a URL as carrying nothing), and
 * refuses `csp` (which turns the WHOLE preview CSP report-only) unless the
 * deployment deliberately runs report-only. Without a `policy`, it serves
 * `sw.js` only with egress within the package CDN's origins. Nothing here can
 * tell a host-made URL from a preview-made one: there is no second check.
 */
import { cspReportUrlOf, egressSources } from './previewCsp.js';
import { WORKER_POLICY_ID } from './relayWorker.js';
import { repeatsAKey } from './swBindings.js';

/** The query parameters the configuration travels in (relay URL → worker URL). */
const PARAMS = { egress: 'egress', policy: 'policy', report: 'report', csp: 'csp' } as const;

/** How the runtime's preview CSP is stamped: enforced (`Content-Security-Policy`), or report-only (`Content-Security-Policy-Report-Only`, migrations only). */
export type PreviewCspMode = 'enforce' | 'report-only';

export interface RelayConfig {
  /** External sources (https/wss origins) this origin's responses may reach. */
  egress?: readonly string[];
  /** The embedder's signed egress policy id for this origin (`[A-Za-z0-9._~-]`, ≤ 512). */
  policy?: string;
  /** An https endpoint for CSP violation reports (`report-to`). */
  report?: string;
  /** `report-only` stamps the policy report-only (travels as `csp=report-only`); anything else enforces it. */
  cspMode?: PreviewCspMode;
}

/** The configuration as the worker trusts it: every part checked, anything malformed dropped. */
export interface CheckedRelayConfig {
  egress: string[];
  policy?: string;
  report?: string;
  /** Present only when report-only: absent (or malformed) means enforce. */
  cspMode?: 'report-only';
}

/** Check a configuration: egress narrowed to well-formed sources, a malformed policy id or report URL dropped. */
export function checkRelayConfig(config: RelayConfig): CheckedRelayConfig {
  return {
    egress: egressSources(config.egress),
    ...(typeof config.policy === 'string' && WORKER_POLICY_ID.test(config.policy) ? { policy: config.policy } : {}),
    ...(cspReportUrlOf(config.report) ? { report: cspReportUrlOf(config.report) } : {}),
    ...(config.cspMode === 'report-only' ? { cspMode: 'report-only' as const } : {}),
  };
}

/** Write `config` (checked) into `url`'s query, replacing whatever configuration it carried. */
function writeConfig(url: URL, config: RelayConfig): URL {
  const checked = checkRelayConfig(config);
  for (const param of Object.values(PARAMS)) url.searchParams.delete(param);
  if (checked.policy) url.searchParams.set(PARAMS.policy, checked.policy);
  if (checked.egress.length > 0) url.searchParams.set(PARAMS.egress, checked.egress.join(' '));
  if (checked.report) url.searchParams.set(PARAMS.report, checked.report);
  if (checked.cspMode) url.searchParams.set(PARAMS.csp, checked.cspMode);
  return url;
}

/**
 * The configuration a relay or worker URL carries (checked: never more than its
 * parts allow). A URL that names any query key more than once is malformed, like
 * an unparsable one: it carries no configuration (`{ egress: [] }` — no extra
 * egress, no policy, no report endpoint, the policy enforced), never "the first
 * value" a server gate might not have checked.
 */
export function relayConfigOf(href: string): CheckedRelayConfig {
  try {
    const params = new URL(href).searchParams;
    if (repeatsAKey(params)) return { egress: [] };
    return checkRelayConfig({
      egress: (params.get(PARAMS.egress) ?? '').split(' ').filter(Boolean),
      policy: params.get(PARAMS.policy) ?? undefined,
      report: params.get(PARAMS.report) ?? undefined,
      cspMode: params.get(PARAMS.csp) === 'report-only' ? 'report-only' : undefined,
    });
  } catch {
    return { egress: [] };
  }
}

/**
 * The error a failed service-worker registration of `scriptUrl` surfaces as. The
 * usual cause on a preview origin is the embedder's gate answering `sw.js` with a
 * 403 because it does not grant the configuration the URL carries — most often an
 * egress source it was not told about, such as a custom `cdn`'s `origins`, which
 * the runtime adds to the egress itself. So the message names that configuration.
 */
export function serviceWorkerRegistrationError(scriptUrl: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  let where = scriptUrl;
  let config: CheckedRelayConfig = { egress: [] };
  try {
    const url = new URL(scriptUrl);
    where = url.origin + url.pathname;
    config = relayConfigOf(url.href);
  } catch {
    // not a URL: named as given, with no configuration to list
  }
  const carried = [
    `egress: ${config.egress.length > 0 ? config.egress.join(' ') : 'none'} (the package CDN's origins plus previewEgress)`,
    ...(config.policy ? [`policy: ${config.policy}`] : []),
    ...(config.report ? [`report: ${config.report}`] : []),
    ...(config.cspMode ? [`csp: ${config.cspMode}`] : []),
  ];
  return new Error(
    `Registering the preview service worker ${where} failed: ${reason}. If the server refused sw.js (403), its gate does not grant ` +
      `this configuration — ${carried.join('; ')}. A custom \`cdn\`'s origins are part of the egress, so the gate (and any signed policy) must grant them too.`,
  );
}

/** The relay URL the host frames for an origin: `relayUrl` with `config` in its query. */
export function relayConfigUrl(relayUrl: string | URL, config: RelayConfig, base?: string): string {
  return writeConfig(new URL(relayUrl, base), config).href;
}

/** The worker URL the relay at `relayHref` registers: `sw.js?mode=relay` beside it, carrying the relay's own configuration. */
export function relayServiceWorkerUrl(relayHref: string): string {
  const url = new URL('./sw.js', relayHref);
  url.searchParams.set('mode', 'relay');
  return writeConfig(url, relayConfigOf(relayHref)).href;
}
