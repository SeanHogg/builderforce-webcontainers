import type { VirtualFileSystem } from './vfs.js';
import { dirname } from './paths.js';
import { resolveLocal } from './resolve.js';

/**
 * The HTML side of a production build: find the page's local entry points
 * (module scripts and stylesheets), then rewrite the page to load their bundles
 * instead — the job Vite's build does to `index.html`.
 */

export interface HtmlEntry {
  tag: 'script' | 'style';
  /** The attribute value as written (`/src/main.tsx`). */
  url: string;
  /** The VFS file it names. */
  path: string;
}

const TAG = /<([a-zA-Z][\w-]*)\b[^>]*>/g;
const URL_ATTR = /(\s(src|href)\s*=\s*)(["'])([^"']*)\3/gi;

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(tag);
  return match?.[2];
}

function isEntryTag(name: string, tag: string): HtmlEntry['tag'] | undefined {
  const lower = name.toLowerCase();
  if (lower === 'script' && attribute(tag, 'type')?.toLowerCase() === 'module' && attribute(tag, 'src')) return 'script';
  if (lower === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attribute(tag, 'rel') ?? '') && attribute(tag, 'href')) return 'style';
  return undefined;
}

/** `%PUBLIC_URL%` (CRA) becomes root-absolute, then is rebased like any other root path. */
function fillPublicUrl(html: string): string {
  return html.replace(/%PUBLIC_URL%/g, '');
}

/** The local file an entry URL names, or undefined for URLs and files that do not exist. */
function resolveEntry(fs: VirtualFileSystem, htmlPath: string, url: string): string | undefined {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return undefined;
  const [path] = url.split(/[?#]/);
  if (!path) return undefined;
  // Root-absolute means the project root (Vite's convention), wherever the page lives.
  return path.startsWith('/') ? resolveLocal(fs, '/', path) : resolveLocal(fs, dirname(htmlPath), path);
}

export function findHtmlEntries(fs: VirtualFileSystem, html: string, htmlPath: string): HtmlEntry[] {
  const entries: HtmlEntry[] = [];
  for (const match of fillPublicUrl(html).matchAll(TAG)) {
    const kind = isEntryTag(match[1]!, match[0]);
    if (!kind) continue;
    const url = attribute(match[0], kind === 'script' ? 'src' : 'href')!;
    const path = resolveEntry(fs, htmlPath, url);
    if (path) entries.push({ tag: kind, url, path });
  }
  return entries;
}

export interface BuiltHtmlOptions {
  /** Where the site is served from, ending in `/` (`./` for relative). */
  base: string;
  entries: HtmlEntry[];
  /** Per entry path, the bundle files (relative to the site root). */
  outputs: Record<string, { js?: string; css?: string }>;
  /** Entry script to add when the page has none of its own (CRA). */
  inject?: string;
}

function insertBefore(html: string, closing: RegExp, markup: string): string {
  return closing.test(html) ? html.replace(closing, (tag) => `${markup}\n${tag}`) : html + markup;
}

export function rewriteBuiltHtml(html: string, options: BuiltHtmlOptions): string {
  const { base, entries, outputs } = options;
  const byUrl = new Map(entries.map((entry) => [`${entry.tag}:${entry.url}`, entry]));
  const stylesheets: string[] = [];

  let out = fillPublicUrl(html).replace(TAG, (tag, name: string) => {
    const kind = isEntryTag(name, tag);
    const entry = kind && byUrl.get(`${kind}:${attribute(tag, kind === 'script' ? 'src' : 'href')}`);
    if (entry) {
      const output = outputs[entry.path];
      const file = entry.tag === 'script' ? output?.js : output?.css;
      if (entry.tag === 'script' && output?.css) stylesheets.push(output.css);
      return file ? tag.replace(URL_ATTR, (m, attr: string, _n, quote: string) => `${attr}${quote}${base}${file}${quote}`) : tag;
    }
    // Any other root-absolute URL (`/favicon.svg` from public/) moves under the base.
    return tag.replace(URL_ATTR, (m, attr: string, _n, quote: string, value: string) =>
      value.startsWith('/') && !value.startsWith('//') ? `${attr}${quote}${base}${value.slice(1)}${quote}` : m,
    );
  });

  if (options.inject) {
    const output = outputs[options.inject];
    if (output?.css) stylesheets.push(output.css);
    if (output?.js) out = insertBefore(out, /<\/body>/i, `<script type="module" src="${base}${output.js}"></script>`);
  }
  const links = [...new Set(stylesheets)].map((css) => `<link rel="stylesheet" href="${base}${css}">`).join('\n');
  return links ? insertBefore(out, /<\/head>/i, links) : out;
}
