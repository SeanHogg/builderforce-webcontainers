import type { VirtualFileSystem } from './vfs.js';
import { dirname } from './paths.js';
import { resolveLocal } from './resolve.js';

/**
 * CSS handling. A stylesheet imported from JS is served as a JS module that
 * injects a <style> tag (keyed by path, so a re-import replaces rather than
 * duplicates). Its relative `url(...)` references are rewritten to absolute
 * preview URLs, because once the text lives in a <style> tag the browser resolves
 * them against the DOCUMENT, not the stylesheet's own location.
 */

const URL_REF = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

export function rewriteCssUrls(fs: VirtualFileSystem, cssPath: string, css: string, base: string): string {
  return css.replace(URL_REF, (match, quote: string, ref: string) => {
    if (/^(data:|https?:|\/\/|#)/i.test(ref)) return match;
    const [pathPart] = ref.split(/[?#]/);
    if (!pathPart) return match;
    const resolved = resolveLocal(fs, dirname(cssPath), pathPart);
    if (!resolved) return match;
    return `url(${quote}${base}${resolved.slice(1)}${ref.slice(pathPart.length)}${quote})`;
  });
}

/**
 * The JS module for an imported stylesheet. `.module.css` exports an identity map
 * (class name → itself): real scoping needs the build API, so for now CSS Modules
 * render correctly as long as class names don't collide.
 */
export function cssToModule(path: string, css: string): string {
  const id = JSON.stringify(path);
  const exportsCssModule = /\.module\.css$/i.test(path);
  return [
    `const css = ${JSON.stringify(css)};`,
    `let el = document.querySelector('style[data-bfwc=' + JSON.stringify(${id}) + ']');`,
    `if (!el) { el = document.createElement('style'); el.setAttribute('data-bfwc', ${id}); document.head.appendChild(el); }`,
    `el.textContent = css;`,
    exportsCssModule
      ? `export default new Proxy({}, { get: (_, key) => typeof key === 'string' ? key : undefined });`
      : `export default css;`,
  ].join('\n');
}

export function jsonToModule(text: string): string {
  // Round-trip so a malformed file fails here with a clear message, not as a
  // syntax error inside generated code.
  return `export default ${JSON.stringify(JSON.parse(text))};`;
}

export function rawToModule(text: string): string {
  return `export default ${JSON.stringify(text)};`;
}

export function urlToModule(url: string): string {
  return `export default ${JSON.stringify(url)};`;
}
