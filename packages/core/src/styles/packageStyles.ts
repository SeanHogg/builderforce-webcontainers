/**
 * A stylesheet imported from a package by JS — `import 'bootstrap/dist/css/bootstrap.css'`.
 * It cannot stay a JS import of a CSS URL, so both the dev server and the build
 * route it through one virtual directory: the dev server answers there with a
 * module that links (or, for Sass/Less, injects) the stylesheet; the build turns
 * it into a CSS `@import` (or the compiled CSS) in the entry's bundle.
 */
export const PACKAGE_STYLE_DIR = 'bfwc-package-css';

const PREFIX = `/${PACKAGE_STYLE_DIR}/`;

/** The virtual path a package stylesheet specifier is served and bundled under. */
export function packageStylePath(specifier: string): string {
  return PREFIX + specifier;
}

/** The package specifier behind a virtual path, or undefined when `path` is not one. */
export function packageStyleSpecifier(path: string): string | undefined {
  return path.startsWith(PREFIX) ? path.slice(PREFIX.length) : undefined;
}

/**
 * A module that adds `<link rel="stylesheet" href>` once (keyed by `key`). A link,
 * not fetched text in a <style>, so the stylesheet's own relative `url()`s
 * (fonts, icons) resolve against the CDN, where those files are.
 */
export function linkStylesheetModule(key: string, href: string): string {
  const id = JSON.stringify(key);
  return [
    `if (!document.querySelector('link[data-bfwc=' + JSON.stringify(${id}) + ']')) {`,
    `  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = ${JSON.stringify(href)}; link.setAttribute('data-bfwc', ${id}); document.head.appendChild(link);`,
    `}`,
    `export default ${JSON.stringify(href)};`,
  ].join('\n');
}
