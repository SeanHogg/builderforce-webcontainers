import type { VirtualFileSystem } from './vfs.js';
import { dirname } from './paths.js';
import { isBareSpecifier, resolveLocal } from './resolve.js';

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
 * A stylesheet's `@import`s, once its text sits in a <style> tag: a relative one
 * (`@import './base.css'`) resolves against the DOCUMENT there, so it becomes the
 * file's preview URL; a package one (`'bootstrap/dist/css/bootstrap.css'`, or
 * `~bootstrap/…`) is fetched from the package CDN, as the build's CSS bundle does.
 */
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?/g;

export function rewriteCssImports(
  fs: VirtualFileSystem,
  cssPath: string,
  css: string,
  base: string,
  packageUrl: (specifier: string) => string,
): string {
  return css.replace(CSS_IMPORT, (match, _quote: string, ref: string) => {
    if (/^(data|https?):|^\/\//i.test(ref)) return match;
    const specifier = ref.startsWith('~') ? ref.slice(1) : ref;
    if (isBareSpecifier(specifier)) {
      const local = !ref.startsWith('~') && resolveLocal(fs, dirname(cssPath), `./${specifier}`);
      return `@import url(${JSON.stringify(local ? base + local.slice(1) : packageUrl(specifier))})`;
    }
    const resolved = resolveLocal(fs, dirname(cssPath), specifier);
    return resolved ? `@import url(${JSON.stringify(base + resolved.slice(1))})` : match;
  });
}

/**
 * A statement that puts `cssExpression` (JS source evaluating to a string) in a
 * <style> tag keyed by `path`: re-evaluating the module replaces the tag's text
 * instead of adding a second tag. Shared by stylesheets and component styles.
 */
export function injectStyleStatement(path: string, cssExpression: string): string {
  const id = JSON.stringify(path);
  return [
    `{ let el = document.querySelector('style[data-bfwc=' + JSON.stringify(${id}) + ']');`,
    `if (!el) { el = document.createElement('style'); el.setAttribute('data-bfwc', ${id}); document.head.appendChild(el); }`,
    `el.textContent = ${cssExpression}; }`,
  ].join('\n');
}

/** The JS module for an imported (plain) stylesheet: inject it, export its text. CSS Modules: `styles/cssModules.ts`. */
export function cssToModule(path: string, css: string): string {
  return [`const css = ${JSON.stringify(css)};`, injectStyleStatement(path, 'css'), `export default css;`].join('\n');
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
