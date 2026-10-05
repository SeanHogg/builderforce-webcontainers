import type { VirtualFileSystem } from './vfs.js';
import type { ProjectConfig } from './projectConfig.js';
import type { PackageCdn } from './packageCdn.js';
import type { BundleHost, BundleLoad, ResolveKind } from './bundler.js';
import type { ComponentCompilers } from './components.js';
import { componentExtension } from './components.js';
import { loaderFor } from './transformer.js';
import { basename, dirname, extname, join } from './paths.js';
import { isBareSpecifier, resolveAlias, resolveLocal, resolvePackage } from './resolve.js';
import { contentHash } from './hash.js';

/**
 * The project side of a production build: the same resolution rules the dev
 * server uses (resolve.ts, tsconfig aliases, the package CDN), expressed as a
 * {@link BundleHost} so any bundler can walk the graph.
 *
 * Packages stay on the CDN — a bare import becomes an absolute, version-pinned
 * URL with the same `?deps=` dedupe as the dev server — so the output runs
 * without node_modules. Assets (images, fonts, `?url`) are emitted by the host
 * itself with content-hashed names, so one asset referenced from JS and CSS is
 * written once.
 */
export interface BuildHostOptions {
  fs: VirtualFileSystem;
  config: ProjectConfig;
  cdn: PackageCdn;
  components: ComponentCompilers;
  publicDir: string;
  /** The URL the site is served under: `./` (relative) or absolute, ending in `/`. */
  base: string;
}

export interface BuildHost extends BundleHost {
  /** Emitted assets, output path (`assets/logo-1a2b3c4d.svg`) → bytes. */
  readonly assets: Map<string, Uint8Array>;
}

/** The query a compiled component's own CSS is imported under. */
const COMPONENT_CSS = 'bfwc-component-css';
/** The query (and virtual directory) of a package stylesheet imported from JS. */
const PACKAGE_CSS = 'bfwc-package-css';
const encoder = new TextEncoder();

function splitAnyQuery(specifier: string): { path: string; query?: string } {
  const at = specifier.indexOf('?');
  return at < 0 ? { path: specifier } : { path: specifier.slice(0, at), query: specifier.slice(at + 1) || undefined };
}

/** Relative base: every chunk and asset lives in `assets/`, so siblings are `./x`. */
function isRelativeBase(base: string): boolean {
  return base.startsWith('.');
}

export function createBuildHost(options: BuildHostOptions): BuildHost {
  const { fs, config, cdn, publicDir, base } = options;
  const assets = new Map<string, Uint8Array>();
  const componentCss = new Map<string, string>();

  function emitAsset(path: string): string {
    const raw = fs.readFile(path) ?? new Uint8Array();
    const bytes = typeof raw === 'string' ? encoder.encode(raw) : raw;
    const ext = extname(path);
    const stem = basename(path).slice(0, basename(path).length - ext.length) || 'asset';
    const name = `${stem}-${contentHash(bytes)}${ext}`;
    assets.set(`assets/${name}`, bytes);
    return name;
  }

  /** An asset's URL from a stylesheet. CSS lives in `assets/` beside it. */
  function cssAssetUrl(path: string): string {
    const name = emitAsset(path);
    return isRelativeBase(base) ? `./${name}` : `${base}assets/${name}`;
  }

  /**
   * An asset imported from JS. With a relative base the URL is resolved against
   * the chunk (`import.meta.url`), not the page — the same app must work when
   * served from any directory, and from client-side routes deeper than `/`.
   */
  function assetModule(path: string): string {
    const name = emitAsset(path);
    return isRelativeBase(base)
      ? `export default new URL(${JSON.stringify(`./${name}`)}, import.meta.url).href;`
      : `export default ${JSON.stringify(`${base}assets/${name}`)};`;
  }

  function resolveFile(fromDir: string, path: string, kind: ResolveKind): string | undefined {
    const local = resolveLocal(fs, fromDir, path);
    if (local) return local;
    // `/vite.svg` in source names `public/vite.svg`, served from the site root.
    if (path.startsWith('/')) return resolveLocal(fs, '/', join(publicDir, path));
    // CSS `url(bg.png)` is relative even without `./`.
    if (kind === 'css-url' || kind === 'css-import') return resolveLocal(fs, fromDir, `./${path}`);
    return undefined;
  }

  return {
    assets,

    resolve(specifier, importer, kind) {
      if (/^(https?:|data:|blob:|node:|\/\/)/i.test(specifier)) return { external: specifier };
      const css = kind === 'css-import' || kind === 'css-url';
      // `~pkg/x.css` is the webpack/Vite spelling of a package path inside CSS.
      const unhashed = (css && specifier.startsWith('~') ? specifier.slice(1) : specifier).split('#');
      const fragment = unhashed.length > 1 ? `#${unhashed.slice(1).join('#')}` : ''; // `icons.svg#close`
      const { path, query } = splitAnyQuery(unhashed[0]!);
      const fromDir = importer ? dirname(importer) : '/';

      let file: string | undefined;
      if (isBareSpecifier(path)) {
        file = (css ? resolveLocal(fs, fromDir, `./${path}`) : undefined) ?? resolveAlias(fs, config.aliases, path);
        if (!file) {
          const { name, subpath } = resolvePackage(config.packageAliases, path);
          // A package stylesheet imported from JS (`import 'bootstrap/dist/css/bootstrap.css'`)
          // can't stay a JS import of a CSS URL; it joins the CSS bundle as an @import.
          if (!css && extname(subpath) === '.css') return { path: `/${PACKAGE_CSS}/${path}`, query: PACKAGE_CSS };
          return { external: cdn.urlFor(name, subpath) };
        }
      } else {
        file = resolveFile(fromDir, path, kind);
      }
      if (!file) return undefined;
      if (kind === 'css-url' && extname(file) !== '.css') return { external: cssAssetUrl(file) + fragment };
      return { path: file, ...(query ? { query } : {}) };
    },

    async load(path, query): Promise<BundleLoad> {
      if (query === 'raw') return { contents: fs.readText(path) ?? '', loader: 'text' };
      if (query === COMPONENT_CSS) return { contents: componentCss.get(path) ?? '', loader: 'css' };
      if (query === PACKAGE_CSS) {
        const { name, subpath } = resolvePackage(config.packageAliases, path.slice(PACKAGE_CSS.length + 2));
        return { contents: `@import ${JSON.stringify(cdn.urlFor(name, subpath))};`, loader: 'css' };
      }

      const ext = extname(path);
      if (query === 'url') return { contents: assetModule(path), loader: 'js' };
      const loader = loaderFor(ext);
      if (loader) return { contents: fs.readFile(path) ?? '', loader };
      if (ext === '.css') return { contents: fs.readFile(path) ?? '', loader: /\.module\.css$/i.test(path) ? 'local-css' : 'css' };
      if (ext === '.json') return { contents: fs.readFile(path) ?? '', loader: 'json' };

      const extension = componentExtension(ext);
      if (extension) {
        const compiler = await options.components(extension, config.dependencies);
        const compiled = await compiler.compile(fs.readText(path) ?? '', { path, dev: false });
        if (!compiled.css) return { contents: compiled.code, loader: compiled.loader };
        componentCss.set(path, compiled.css);
        // Importing its own CSS puts the component's styles in the entry's CSS bundle.
        return { contents: `${compiled.code}\nimport ${JSON.stringify(`${path}?${COMPONENT_CSS}`)};`, loader: compiled.loader };
      }
      return { contents: assetModule(path), loader: 'js' };
    },
  };
}
