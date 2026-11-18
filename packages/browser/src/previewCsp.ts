/**
 * The Content-Security-Policy the preview service worker stamps on every preview
 * document it routes (make.md › PRD 31 §4 W10, control 6, preview side). Pure:
 * the worker and the tests share it.
 *
 * - `connect-src`: the preview's own origin, `blob:`/`data:` (not network egress)
 *   and the egress the host declared for it — nothing else. The policy never
 *   names `/__bfwc/` paths: requests there are routed and judged by the worker.
 * - `worker-src 'self' blob:`: a blob: Worker inherits its document's policy
 *   (CSP3), so it stays covered.
 *
 * It is ADDED as a second policy, never merged into or replacing the app's own:
 * browsers enforce every policy a response carries, so the result is at least as
 * strict as each — the app's stricter CSP survives, and ours always applies.
 */

/** An egress source the host may declare: an https or wss origin, optionally `*.`-wildcarded, no path. */
const EGRESS_SOURCE = /^(?:https|wss):\/\/(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

/** At most this many egress sources per preview; the rest are dropped (never widened to a wildcard). */
const MAX_EGRESS = 64;

/** The well-formed egress sources in `egress`, deduplicated and lowercased; anything else (paths, keywords, quotes, `;`) is dropped. */
export function egressSources(egress: unknown): string[] {
  if (!Array.isArray(egress)) return [];
  const sources = new Set<string>();
  for (const entry of egress) {
    if (typeof entry === 'string' && EGRESS_SOURCE.test(entry)) sources.add(entry.toLowerCase());
    if (sources.size >= MAX_EGRESS) break;
  }
  return [...sources];
}

/** The policy a preview document gets, for its declared egress. */
export function previewDocumentPolicy(egress: unknown): string {
  return [["connect-src 'self' blob: data:", ...egressSources(egress)].join(' '), "worker-src 'self' blob:"].join('; ');
}

function headerKey(headers: Record<string, string>, name: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === name);
}

/** Whether a routed response is a document (HTML or XHTML) the policy belongs on. */
export function isDocumentResponse(headers: Record<string, string>): boolean {
  const key = headerKey(headers, 'content-type');
  return key !== undefined && /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(headers[key]!);
}

/** `headers` with `policy` added as a further Content-Security-Policy (after any the app set, which keeps applying). */
export function stampPreviewCsp(headers: Record<string, string>, policy: string): Record<string, string> {
  const key = headerKey(headers, 'content-security-policy');
  const existing = key === undefined ? '' : headers[key]!.trim();
  const out = { ...headers };
  if (key !== undefined) delete out[key];
  // A comma separates policies in one header value: each is enforced on its own.
  out['content-security-policy'] = existing ? `${existing}, ${policy}` : policy;
  return out;
}
