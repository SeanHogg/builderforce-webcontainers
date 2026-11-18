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
 * which the browser fetches from the embedder's server — and the embedder serves
 * `sw.js` only when `policy` verifies for that origin and `egress`/`report` are
 * exactly what that policy grants (README › Preview origin headers). Without a
 * `policy`, the embedder serves `sw.js` only with no `egress`: the most
 * restrictive policy.
 */
import { cspReportUrlOf, egressSources } from './previewCsp.js';
import { WORKER_POLICY_ID } from './relayWorker.js';

/** The query parameters the configuration travels in (relay URL → worker URL). */
const PARAMS = { egress: 'egress', policy: 'policy', report: 'report' } as const;

export interface RelayConfig {
  /** External sources (https/wss origins) this origin's responses may reach. */
  egress?: readonly string[];
  /** The embedder's signed egress policy id for this origin (`[A-Za-z0-9._~-]`, ≤ 512). */
  policy?: string;
  /** An https endpoint for CSP violation reports (`report-to`). */
  report?: string;
}

/** The configuration as the worker trusts it: every part checked, anything malformed dropped. */
export interface CheckedRelayConfig {
  egress: string[];
  policy?: string;
  report?: string;
}

/** Check a configuration: egress narrowed to well-formed sources, a malformed policy id or report URL dropped. */
export function checkRelayConfig(config: RelayConfig): CheckedRelayConfig {
  return {
    egress: egressSources(config.egress),
    ...(typeof config.policy === 'string' && WORKER_POLICY_ID.test(config.policy) ? { policy: config.policy } : {}),
    ...(cspReportUrlOf(config.report) ? { report: cspReportUrlOf(config.report) } : {}),
  };
}

/** Write `config` (checked) into `url`'s query, replacing whatever configuration it carried. */
function writeConfig(url: URL, config: RelayConfig): URL {
  const checked = checkRelayConfig(config);
  for (const param of Object.values(PARAMS)) url.searchParams.delete(param);
  if (checked.policy) url.searchParams.set(PARAMS.policy, checked.policy);
  if (checked.egress.length > 0) url.searchParams.set(PARAMS.egress, checked.egress.join(' '));
  if (checked.report) url.searchParams.set(PARAMS.report, checked.report);
  return url;
}

/** The configuration a relay or worker URL carries (checked: never more than its parts allow). */
export function relayConfigOf(href: string): CheckedRelayConfig {
  try {
    const params = new URL(href).searchParams;
    return checkRelayConfig({
      egress: (params.get(PARAMS.egress) ?? '').split(' ').filter(Boolean),
      policy: params.get(PARAMS.policy) ?? undefined,
      report: params.get(PARAMS.report) ?? undefined,
    });
  } catch {
    return { egress: [] };
  }
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
