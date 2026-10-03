/**
 * The production bundler, as a PORT — the build-time sibling of {@link Transformer}.
 *
 * The split of responsibilities is deliberate: everything that knows about the
 * project (how a specifier resolves, what a file compiles to, where assets go)
 * lives behind {@link BundleHost}, written once in the core; a bundler only walks
 * the graph through the host's two callbacks and writes chunks. So the esbuild
 * adapter below is the only esbuild-specific code, and a fork could put Rollup
 * behind the same port without re-implementing resolution.
 */
import type { Loader } from './transformer.js';

export type BundleLoader = Loader | 'css' | 'local-css' | 'json' | 'text';

/** Where an import appears: an entry point, JS, a CSS `@import`, or a CSS `url()`. */
export type ResolveKind = 'entry' | 'import' | 'css-import' | 'css-url';

/** A module inside the graph (with an optional `?query`), or a URL left as-is in the output. */
export type BundleResolution = { path: string; query?: string } | { external: string };

export interface BundleLoad {
  contents: string | Uint8Array;
  loader: BundleLoader;
}

export interface BundleHost {
  /** Undefined means "cannot resolve", reported as a build error. */
  resolve(specifier: string, importer: string | undefined, kind: ResolveKind): BundleResolution | undefined;
  load(path: string, query: string | undefined): Promise<BundleLoad> | BundleLoad;
}

export interface BundleRequest {
  /** VFS paths of the entry modules (scripts or stylesheets). */
  entryPoints: string[];
  host: BundleHost;
  /** esbuild `define` semantics (values are JS source). */
  define: Record<string, string>;
  jsx: { runtime: 'automatic' | 'classic'; importSource: string };
  minify: boolean;
}

export interface BundleOutputFile {
  /** Relative to the site root, e.g. `assets/main-1a2b3c4d.js`. */
  path: string;
  contents: Uint8Array;
}

export interface BundleOutput {
  files: BundleOutputFile[];
  /** Per entry point (VFS path): its JS chunk and the CSS extracted from it. */
  entries: Record<string, { js?: string; css?: string }>;
}

export interface Bundler {
  bundle(request: BundleRequest): Promise<BundleOutput>;
}

// ---- esbuild adapter ------------------------------------------------------

interface EsbuildResolveArgs {
  path: string;
  importer: string;
  kind: string;
}

interface EsbuildLoadArgs {
  path: string;
  suffix?: string;
}

interface EsbuildResolveResult {
  path?: string;
  namespace?: string;
  suffix?: string;
  external?: boolean;
  errors?: Array<{ text: string }>;
}

interface EsbuildPluginBuild {
  onResolve(options: { filter: RegExp }, callback: (args: EsbuildResolveArgs) => EsbuildResolveResult): void;
  onLoad(
    options: { filter: RegExp; namespace: string },
    callback: (args: EsbuildLoadArgs) => Promise<{ contents: string | Uint8Array; loader: BundleLoader }>,
  ): void;
}

/** The subset of esbuild's (and esbuild-wasm's) `build` API the adapter uses. */
export interface EsbuildBuildLike {
  build(options: {
    entryPoints: string[];
    bundle: true;
    write: false;
    metafile: true;
    format: 'esm';
    splitting: true;
    target: string;
    outdir: string;
    entryNames: string;
    chunkNames: string;
    assetNames: string;
    minify: boolean;
    define: Record<string, string>;
    jsx: 'automatic' | 'transform';
    jsxImportSource?: string;
    charset: 'utf8';
    logLevel: 'silent';
    plugins: Array<{ name: string; setup(build: EsbuildPluginBuild): void }>;
  }): Promise<{
    outputFiles?: Array<{ path: string; contents: Uint8Array }>;
    metafile?: { outputs: Record<string, { entryPoint?: string; cssBundle?: string }> };
  }>;
}

const NAMESPACE = 'bfwc';
/** A marker directory: nothing is written; output paths are made relative to it. */
const OUT_DIR = '__bfwc_dist__';

const KINDS: Record<string, ResolveKind> = {
  'entry-point': 'entry',
  'import-rule': 'css-import',
  'composes-from': 'css-import',
  'url-token': 'css-url',
};

/** An output path (absolute, OS-specific, or metafile-relative) → `assets/x.js`. */
function relativeOutput(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const at = normalized.lastIndexOf(`${OUT_DIR}/`);
  return at < 0 ? normalized : normalized.slice(at + OUT_DIR.length + 1);
}

/** Adapt esbuild or esbuild-wasm's `build` to {@link Bundler}. */
export function createEsbuildBundler(esbuild: EsbuildBuildLike): Bundler {
  return {
    async bundle(request) {
      const { host } = request;
      const result = await esbuild.build({
        entryPoints: request.entryPoints,
        bundle: true,
        write: false,
        metafile: true,
        format: 'esm',
        splitting: true,
        target: 'es2022',
        outdir: OUT_DIR,
        entryNames: 'assets/[name]-[hash]',
        chunkNames: 'assets/[name]-[hash]',
        assetNames: 'assets/[name]-[hash]',
        minify: request.minify,
        define: request.define,
        jsx: request.jsx.runtime === 'automatic' ? 'automatic' : 'transform',
        ...(request.jsx.runtime === 'automatic' ? { jsxImportSource: request.jsx.importSource } : {}),
        charset: 'utf8',
        logLevel: 'silent',
        plugins: [
          {
            name: 'bfwc-vfs',
            setup(build) {
              build.onResolve({ filter: /.*/ }, (args) => {
                const importer = args.importer || undefined;
                const resolved = host.resolve(args.path, importer, KINDS[args.kind] ?? 'import');
                if (!resolved) return { errors: [{ text: `Cannot resolve "${args.path}"${importer ? ` from ${importer}` : ''}` }] };
                if ('external' in resolved) return { path: resolved.external, external: true };
                return { path: resolved.path, namespace: NAMESPACE, ...(resolved.query ? { suffix: `?${resolved.query}` } : {}) };
              });
              build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
                const query = args.suffix?.startsWith('?') ? args.suffix.slice(1) : undefined;
                return host.load(args.path, query);
              });
            },
          },
        ],
      });

      const files = (result.outputFiles ?? []).map((file) => ({ path: relativeOutput(file.path), contents: file.contents }));
      const entries: BundleOutput['entries'] = {};
      for (const [output, meta] of Object.entries(result.metafile?.outputs ?? {})) {
        if (!meta.entryPoint) continue;
        const entry = meta.entryPoint.replace(`${NAMESPACE}:`, '').replace(/\?.*$/, '');
        const slot = (entries[entry] ??= {});
        if (output.endsWith('.css')) slot.css = relativeOutput(output);
        else {
          slot.js = relativeOutput(output);
          if (meta.cssBundle) slot.css = relativeOutput(meta.cssBundle);
        }
      }
      return { files, entries };
    },
  };
}
