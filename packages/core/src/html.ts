/**
 * Prepare the project's HTML for the preview:
 *   • absolute `src`/`href` paths (`/src/main.tsx`) are re-rooted under the preview
 *     base, since the preview is served from a sub-path, not the origin root;
 *   • CRA's `%PUBLIC_URL%` placeholder is filled;
 *   • a page with no module script (CRA) gets its entry injected;
 *   • the error bridge is prepended, so runtime errors and console output reach the host;
 *   • the host's preview scripts run next, before the app;
 *   • the live-reload listener is prepended, so an edit re-renders the preview;
 *   • the attribution badge is appended unless the host turned it off.
 */
import { injectAttribution } from './attribution.js';

export const ERROR_MESSAGE_TYPE = 'bfwc:error';
export const CONSOLE_MESSAGE_TYPE = 'bfwc:console';
/** Console messages forwarded per page load; past this the bridge goes quiet (a log loop must not flood the host). */
export const CONSOLE_MESSAGE_LIMIT = 1000;

/**
 * Runs first in the preview. Forwards uncaught errors and rejections, and the
 * app's console output, to the host page (`window.parent`): how an editor — or
 * an agent — learns what the app did without scraping the iframe. Console
 * arguments are flattened to text (errors with their stack, objects as JSON),
 * each message capped at 4,000 characters.
 */
export function errorBridgeScript(): string {
  return `<script>(function(){
  var send = function (message, stack) {
    try { parent.postMessage({ type: ${JSON.stringify(ERROR_MESSAGE_TYPE)}, message: String(message), stack: stack ? String(stack) : undefined, href: location.href }, '*'); } catch (_) {}
  };
  addEventListener('error', function (e) { send(e.message, e.error && e.error.stack); });
  addEventListener('unhandledrejection', function (e) { var r = e.reason; send(r && r.message ? r.message : r, r && r.stack); });
  var sent = 0;
  var text = function (value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || String(value);
    try { var json = JSON.stringify(value); return json === undefined ? String(value) : json; } catch (_) { return String(value); }
  };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      if (sent < ${CONSOLE_MESSAGE_LIMIT}) {
        sent++;
        try { parent.postMessage({ type: ${JSON.stringify(CONSOLE_MESSAGE_TYPE)}, level: level, text: Array.prototype.map.call(arguments, text).join(' ').slice(0, 4000), href: location.href }, '*'); } catch (_) {}
      }
      return original.apply(console, arguments);
    };
  });
  window.process = window.process || { env: { NODE_ENV: 'development' } };
})();</script>`;
}

/**
 * The channel a preview listens on for "files changed, reload". Keyed by the
 * preview base, so two runtimes on one origin never reload each other's frames.
 * A BroadcastChannel rather than `postMessage` because the host does not hold a
 * reference to the frame — any number of frames (or tabs) may show one preview.
 */
export function reloadChannelName(base: string): string {
  return `bfwc:reload:${base}`;
}

export function liveReloadScript(base: string): string {
  return `<script>(function(){
  if (typeof BroadcastChannel === 'undefined') return;
  new BroadcastChannel(${JSON.stringify(reloadChannelName(base))}).onmessage = function () { location.reload(); };
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
  /** Host scripts (JavaScript source) run in every preview page before the app. */
  scripts?: readonly string[];
}

/** `</script>` inside a script body would end the tag early. */
const scriptTag = (source: string) => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;

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

  const bridge = [errorBridgeScript(), liveReloadScript(base), ...(options.scripts ?? []).map(scriptTag)].join('\n');
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (head) => `${head}\n${bridge}`);
  return bridge + out;
}
