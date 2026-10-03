/**
 * Prepare the project's HTML for the preview:
 *   • absolute `src`/`href` paths (`/src/main.tsx`) are re-rooted under the preview
 *     base, since the preview is served from a sub-path, not the origin root;
 *   • CRA's `%PUBLIC_URL%` placeholder is filled;
 *   • a page with no module script (CRA) gets its entry injected;
 *   • the error bridge is prepended, so runtime errors reach the host;
 *   • the attribution badge is appended unless the host turned it off.
 */
import { injectAttribution } from './attribution.js';

export const ERROR_MESSAGE_TYPE = 'bfwc:error';

/**
 * Runs first in the preview. Forwards uncaught errors and rejections to the host
 * page (`window.parent`), which is how an editor — or an agent — learns the app
 * crashed without scraping the iframe.
 */
export function errorBridgeScript(): string {
  return `<script>(function(){
  var send = function (message, stack) {
    try { parent.postMessage({ type: ${JSON.stringify(ERROR_MESSAGE_TYPE)}, message: String(message), stack: stack ? String(stack) : undefined, href: location.href }, '*'); } catch (_) {}
  };
  addEventListener('error', function (e) { send(e.message, e.error && e.error.stack); });
  addEventListener('unhandledrejection', function (e) { var r = e.reason; send(r && r.message ? r.message : r, r && r.stack); });
  window.process = window.process || { env: { NODE_ENV: 'development' } };
})();</script>`;
}

const ABSOLUTE_ATTR = /(\s(?:src|href)\s*=\s*)(["'])\/(?!\/)([^"']*)\2/gi;
const MODULE_SCRIPT = /<script\b[^>]*type\s*=\s*["']module["'][^>]*>/i;

export interface HtmlOptions {
  /** Preview base URL, ending in `/`. */
  base: string;
  /** Entry injected when the page has no module script. */
  entry?: string;
  /** The "Built with Builderforce.ai" badge. On unless explicitly `false`. */
  attribution?: boolean;
}

export function transformHtml(html: string, options: HtmlOptions): string {
  const { base } = options;
  // `%PUBLIC_URL%/logo.png` becomes root-absolute here and is re-rooted once below;
  // filling in the base directly would let the re-rooting prefix it a second time.
  let out = html.replace(/%PUBLIC_URL%/g, '');
  out = out.replace(ABSOLUTE_ATTR, (_m, attr: string, quote: string, rest: string) => `${attr}${quote}${base}${rest}${quote}`);

  if (options.entry && !MODULE_SCRIPT.test(out)) {
    const tag = `<script type="module" src="${base}${options.entry.slice(1)}"></script>`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${tag}\n</body>`) : out + tag;
  }
  if (options.attribution !== false) out = injectAttribution(out);

  const bridge = errorBridgeScript();
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (head) => `${head}\n${bridge}`);
  return bridge + out;
}
