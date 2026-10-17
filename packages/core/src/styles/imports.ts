import type { VirtualFileSystem } from '../vfs.js';
import { dirname, join, normalizePath } from '../paths.js';
import { isRegistryRange } from '../packageCdn.js';
import { splitPackageSpecifier } from '../resolve.js';
import { styleLanguageOf, type StyleLanguage } from './languages.js';

/**
 * Where a preprocessor's `@use` / `@import` finds its files: the project's own
 * files first, then an installed `node_modules`, then the package on a CDN — so
 * `@use 'bootstrap/scss/functions'` works whether or not `npm install` has run.
 *
 * Ids are VFS paths (`/src/_vars.scss`) for project and installed files and
 * absolute URLs for CDN files, so a CDN file's own relative imports resolve
 * against its URL.
 */
export interface StyleSource {
  id: string;
  contents: string;
  language: StyleLanguage;
}

export interface StyleImportHost {
  /**
   * The id of the file `specifier` names from the stylesheet `from` (an id, or
   * undefined for the entry), trying each path `candidates` derives — partials,
   * extensions, index files, which differ per language.
   */
  resolve(specifier: string, from: string | undefined, candidates: (path: string) => string[]): Promise<string | undefined>;
  load(id: string): Promise<StyleSource>;
}

export interface StyleImportHostOptions {
  fs: VirtualFileSystem;
  /** The project's dependency ranges, which pin CDN package files. */
  dependencies: Readonly<Record<string, string>>;
  /** Fetches a CDN file's text, or undefined when it does not exist. Default: `fetch`. */
  fetchText?: (url: string) => Promise<string | undefined>;
  /** A package file's URL. Default: jsDelivr, which serves package files as published. */
  packageFileUrl?: (name: string, range: string, subpath: string) => string;
}

export const jsDelivrFileUrl = (name: string, range: string, subpath: string): string => `https://cdn.jsdelivr.net/npm/${name}@${range}${subpath}`;

const defaultFetchText = async (url: string): Promise<string | undefined> => {
  const res = await fetch(url);
  return res.ok ? res.text() : undefined;
};

const isUrl = (id: string) => /^https?:\/\//i.test(id);

export function createStyleImportHost(options: StyleImportHostOptions): StyleImportHost {
  const { fs, dependencies } = options;
  const fetchText = options.fetchText ?? defaultFetchText;
  const packageFileUrl = options.packageFileUrl ?? jsDelivrFileUrl;
  /** A CDN probe answers the same way for the host's lifetime, found or not. */
  const remote = new Map<string, Promise<string | undefined>>();

  const fetchCached = (url: string) => {
    let pending = remote.get(url);
    if (!pending) {
      pending = fetchText(url).catch(() => undefined);
      remote.set(url, pending);
    }
    return pending;
  };

  async function exists(id: string): Promise<boolean> {
    return isUrl(id) ? (await fetchCached(id)) !== undefined : fs.isFile(id);
  }

  async function firstExisting(paths: string[]): Promise<string | undefined> {
    for (const path of paths) if (await exists(path)) return path;
    return undefined;
  }

  /** A package's own stylesheet entry (`"sass"` / `"style"` in its package.json), for `@use 'pkg'`. */
  async function packageEntry(root: string): Promise<string | undefined> {
    const manifest = isUrl(root) ? await fetchCached(`${root}/package.json`) : fs.readText(join(root, 'package.json'));
    if (!manifest) return undefined;
    try {
      const json = JSON.parse(manifest) as { sass?: unknown; style?: unknown };
      const entry = typeof json.sass === 'string' ? json.sass : typeof json.style === 'string' ? json.style : undefined;
      return entry ? (isUrl(root) ? new URL(entry, `${root}/`).href : join(root, entry)) : undefined;
    } catch {
      return undefined;
    }
  }

  async function fromPackage(specifier: string, candidates: (path: string) => string[]): Promise<string | undefined> {
    const { name, subpath } = splitPackageSpecifier(specifier);
    const range = dependencies[name];
    const roots = [`/node_modules/${name}`, packageFileUrl(name, range && isRegistryRange(range) ? range : 'latest', '')];
    for (const root of roots) {
      if (!subpath) {
        const entry = await packageEntry(root);
        if (entry && (await exists(entry))) return entry;
        continue;
      }
      const hit = await firstExisting(candidates(`${root}${subpath}`));
      if (hit) return hit;
    }
    return undefined;
  }

  return {
    async resolve(specifier, from, candidates) {
      const spec = specifier.startsWith('~') ? specifier.slice(1) : specifier;
      if (isUrl(spec)) return firstExisting(candidates(spec));
      const relative = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
      // Preprocessors look beside the importing file first, even for `@use 'vars'`.
      if (!specifier.startsWith('~')) {
        const near = !from ? normalizePath(spec) : isUrl(from) ? new URL(spec, from).href : spec.startsWith('/') ? normalizePath(spec) : join(dirname(from), spec);
        const hit = await firstExisting(candidates(near));
        if (hit || relative) return hit;
      }
      return fromPackage(spec, candidates);
    },

    async load(id) {
      const contents = isUrl(id) ? await fetchCached(id) : fs.readText(id);
      if (contents === undefined) throw new Error(`Cannot read stylesheet ${id}`);
      return { id, contents, language: styleLanguageOf(id.replace(/[?#].*$/, '')) ?? 'css' };
    },
  };
}
