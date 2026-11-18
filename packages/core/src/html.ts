/**
 * Prepare the project's HTML for the preview:
 *   • absolute `src`/`href` paths (`/src/main.tsx`) are re-rooted under the preview
 *     base, since the preview is served from a sub-path, not the origin root;
 *   • CRA's `%PUBLIC_URL%` placeholder is filled;
 *   • a page with no module script (CRA) gets its entry injected;
 *   • the error bridge is prepended, so runtime errors and console output reach the host;
 *   • the WebSocket bridge follows, so `new WebSocket('ws://localhost:3000')` reaches a virtual server;
 *   • the host's preview scripts run next, before the app;
 *   • the hot-update listener is prepended, so an edit swaps styles, re-renders
 *     components or reloads — and, for React, the Fast Refresh runtime before the app;
 *   • the attribution badge is appended unless the host turned it off.
 */
import { attributionEnabled, injectAttribution, type AttributionSetting } from './attribution.js';
import { previewSocketScript, scriptLiteral } from './previewBridge.js';
import { hotUpdateScript } from './hot/client.js';
import { refreshPreambleScript } from './hot/reactRefresh.js';

export const ERROR_MESSAGE_TYPE = 'bfwc:error';
export const CONSOLE_MESSAGE_TYPE = 'bfwc:console';
/** Console messages forwarded per page load; past this the bridge goes quiet (a log loop must not flood the host). */
export const CONSOLE_MESSAGE_LIMIT = 1000;
/** Error messages forwarded per page load, counted apart from console output; an error loop must not flood the host either. */
export const ERROR_MESSAGE_LIMIT = 100;
/** What raised a forwarded error: an uncaught throw, an unhandled rejection, or (Angular pages) an Error / NG-coded string passed to `console.error`. */
export type PreviewErrorSource = 'error' | 'rejection' | 'console';

/**
 * Runs first in the preview. Forwards uncaught errors and rejections, and the
 * app's console output, to the host page (`window.parent`): how an editor — or
 * an agent — learns what the app did without scraping the iframe. Console
 * arguments are flattened to text (errors with their stack, objects as JSON),
 * each message capped at 4,000 characters. Errors are posted raw; the host
 * extracts framework codes (see previewErrorText.ts). Each message carries
 * `nonce`, the runtime's (see previewBridge.ts), which the host checks.
 *
 * With `forwardConsoleErrors` (the dev server sets it for Angular apps only), a
 * `console.error` is ALSO forwarded as an error (`source: 'console'`) when one
 * of its arguments is an Error object or a string naming an Angular code
 * (`NG0303`): that is how a failed
 * `bootstrapApplication(...).catch(err => console.error(err))`, Angular's
 * ErrorHandler and its template-binding checks report, with no uncaught error at
 * all. Off, `console.error` is console output only — other frameworks (and
 * libraries) log errors they handled, which a host must not count as failures.
 */
export interface ErrorBridgeOptions {
  forwardConsoleErrors?: boolean;
}

/** An Angular runtime/compiler error code inside a console string (`NG0303`, `NG02100`, `NG8001`). */
const NG_CODE = /\bNG0?\d{4}\b/;

export function errorBridgeScript(nonce = '', options: ErrorBridgeOptions = {}): string {
  const forward = options.forwardConsoleErrors
    ? `
      if (level === 'error') {
        var raised;
        for (var i = 0; i < arguments.length; i++) if (arguments[i] instanceof Error) { raised = arguments[i]; break; }
        if (raised) send(raised.message, raised.stack, 'console');
        else {
          for (var j = 0; j < arguments.length; j++) {
            if (typeof arguments[j] === 'string' && ${NG_CODE}.test(arguments[j])) { send(Array.prototype.map.call(arguments, text).join(' ').slice(0, 4000), undefined, 'console'); break; }
          }
        }
      }`
    : '';
  return `<script>(function(){
  var NONCE = ${scriptLiteral(nonce)};
  var errors = 0;
  var send = function (message, stack, source) {
    if (errors >= ${ERROR_MESSAGE_LIMIT}) return;
    errors++;
    try { parent.postMessage({ type: ${JSON.stringify(ERROR_MESSAGE_TYPE)}, source: source, message: String(message), stack: stack ? String(stack) : undefined, href: location.href, nonce: NONCE }, '*'); } catch (_) {}
  };
  addEventListener('error', function (e) { send(e.message, e.error && e.error.stack, 'error'); });
  addEventListener('unhandledrejection', function (e) { var r = e.reason; send(r && r.message ? r.message : r, r && r.stack, 'rejection'); });
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
        try { parent.postMessage({ type: ${JSON.stringify(CONSOLE_MESSAGE_TYPE)}, level: level, text: Array.prototype.map.call(arguments, text).join(' ').slice(0, 4000), href: location.href, nonce: NONCE }, '*'); } catch (_) {}
      }${forward}
      return original.apply(console, arguments);
    };
  });
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
  /** The "Built with Builderforce.ai" badge. On unless explicitly `false`; a predicate is asked per page. */
  attribution?: AttributionSetting;
  /** Host scripts (JavaScript source) run in every preview page before the app. */
  scripts?: readonly string[];
  /** URL of `react-refresh/runtime`; installed before the app so components re-render in place on edits. */
  refreshRuntime?: string;
  /** The runtime's nonce, carried by every message the bridge posts to the host. */
  nonce?: string;
  /** Forward `console.error` of an Error / Angular-coded string as an error too (see {@link errorBridgeScript}). Angular pages only. */
  forwardConsoleErrors?: boolean;
}

/** A host script as a tag. `</script>` inside the body would end the tag early, so it is escaped. */
export const scriptTag = (source: string): string => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;

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
  if (attributionEnabled(options.attribution)) out = injectAttribution(out);

  const bridge = [
    errorBridgeScript(options.nonce, { forwardConsoleErrors: options.forwardConsoleErrors }),
    previewSocketScript(options.nonce),
    hotUpdateScript(base),
    ...(options.scripts ?? []).map(scriptTag),
    ...(options.refreshRuntime ? [refreshPreambleScript(options.refreshRuntime)] : []),
  ].join('\n');
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head[^>]*>/i, (head) => `${head}\n${bridge}`);
  return bridge + out;
}
