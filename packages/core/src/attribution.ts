/**
 * The "Built with Builderforce.ai" badge, on by default in every preview.
 *
 * It is a DEFAULT, not a licence condition: the project stays MIT, and a host turns
 * it off with `attribution: false`. Keeping it on is how this runtime pays for
 * itself, and the README asks forks to leave it.
 *
 * The badge lives in a shadow root, so the previewed app's CSS can't restyle or hide
 * it by accident and the badge's styles can't leak into the app. It follows the
 * system light/dark preference and sits in the bottom-right corner, small enough
 * not to cover app UI on a phone-width screen.
 */

export const ATTRIBUTION_URL = 'https://builderforce.ai/?utm_source=webcontainers&utm_medium=badge&utm_campaign=preview';
export const ATTRIBUTION_LABEL = 'Built with Builderforce.ai';

export interface AttributionOptions {
  href?: string;
  label?: string;
}

export function attributionScript(options: AttributionOptions = {}): string {
  const href = JSON.stringify(options.href ?? ATTRIBUTION_URL);
  const label = JSON.stringify(options.label ?? ATTRIBUTION_LABEL);
  const css = [
    ':host{all:initial;position:fixed;right:8px;bottom:8px;z-index:2147483647}',
    'a{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;',
    'font:500 12px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;text-decoration:none;',
    'background:rgba(255,255,255,.92);color:#1f2328;border:1px solid rgba(31,35,40,.15);',
    'box-shadow:0 1px 3px rgba(0,0,0,.12)}',
    'a:hover{text-decoration:underline}',
    '@media (prefers-color-scheme:dark){a{background:rgba(22,27,34,.92);color:#e6edf3;border-color:rgba(230,237,243,.18)}}',
    '@media print{:host{display:none}}',
  ].join('');
  return `<script>(function(){
  if (document.getElementById('bfwc-attribution')) return;
  var mount = function () {
    var host = document.createElement('bfwc-attribution');
    host.id = 'bfwc-attribution';
    var root = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = ${JSON.stringify(css)};
    var a = document.createElement('a');
    a.href = ${href}; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = ${label};
    root.appendChild(style); root.appendChild(a);
    document.body.appendChild(host);
  };
  if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
})();</script>`;
}

/** Append the badge before `</body>` (or at the end of a fragment). */
export function injectAttribution(html: string, options?: AttributionOptions): string {
  const badge = attributionScript(options);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${badge}\n</body>`) : html + badge;
}
