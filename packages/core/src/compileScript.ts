import type { VirtualFileSystem } from './vfs.js';
import type { ProjectConfig } from './projectConfig.js';
import type { PackageCdn } from './packageCdn.js';
import type { Transformer } from './transformer.js';
import { loaderFor } from './transformer.js';
import { dirname, extname } from './paths.js';
import { isBareSpecifier, resolveAlias, resolveLocal, splitPackageSpecifier } from './resolve.js';
import { rewriteImports } from './rewriteImports.js';

export interface CompileContext {
  fs: VirtualFileSystem;
  config: ProjectConfig;
  cdn: PackageCdn;
  transformer: Transformer;
  /** Preview base URL, ending in `/`. */
  base: string;
}

/** Vite-style import queries this runtime honours. */
export type ImportQuery = 'import' | 'raw' | 'url';

/**
 * The URL a resolved VFS file is imported by. Scripts are served as-is; CSS and
 * JSON need the `?import` JS wrapper; anything else imported from JS (images,
 * fonts) exports its URL, as in Vite.
 */
export function moduleUrl(base: string, path: string, query?: ImportQuery): string {
  const url = base + path.slice(1);
  if (query === 'raw' || query === 'url') return `${url}?${query}`;
  const ext = extname(path);
  if (loaderFor(ext)) return url;
  if (ext === '.css' || ext === '.json') return `${url}?import`;
  return `${url}?url`;
}

function splitQuery(specifier: string): { path: string; query?: ImportQuery } {
  const at = specifier.indexOf('?');
  if (at < 0) return { path: specifier };
  const query = specifier.slice(at + 1);
  return { path: specifier.slice(0, at), query: query === 'raw' || query === 'url' ? query : undefined };
}

/**
 * Map one import specifier to the URL the browser should fetch. Undefined leaves
 * it unchanged: URLs, `node:` builtins, and local paths that do not resolve (the
 * browser's 404 then surfaces through the error bridge).
 */
export function mapSpecifier(ctx: CompileContext, fromDir: string, specifier: string): string | undefined {
  if (/^(https?:|data:|blob:|node:)/i.test(specifier)) return undefined;
  const { path, query } = splitQuery(specifier);

  if (isBareSpecifier(path)) {
    const aliased = resolveAlias(ctx.fs, ctx.config.aliases, path);
    if (aliased) return moduleUrl(ctx.base, aliased, query);
    const { name, subpath } = splitPackageSpecifier(path);
    return ctx.cdn.urlFor(name, subpath);
  }
  const resolved = resolveLocal(ctx.fs, fromDir, path);
  return resolved ? moduleUrl(ctx.base, resolved, query) : undefined;
}

/** Compile-time constants: Vite's `import.meta.env` and CRA's `process.env.REACT_APP_*`. */
export function buildDefine(config: ProjectConfig, base: string): Record<string, string> {
  const env: Record<string, unknown> = { MODE: 'development', DEV: true, PROD: false, SSR: false, BASE_URL: base };
  const define: Record<string, string> = { 'process.env.NODE_ENV': '"development"' };
  for (const [key, value] of Object.entries(config.env)) {
    if (key.startsWith('VITE_')) env[key] = value;
    if (key.startsWith('VITE_') || key.startsWith('REACT_APP_')) define[`process.env.${key}`] = JSON.stringify(value);
  }
  define['import.meta.env'] = JSON.stringify(env);
  return define;
}

/** TS/JSX → an ES module whose imports point at preview and CDN URLs. */
export async function compileScript(ctx: CompileContext, path: string): Promise<string> {
  const loader = loaderFor(extname(path));
  if (!loader) throw new Error(`Not a script: ${path}`);
  const source = ctx.fs.readText(path) ?? '';
  const { code } = await ctx.transformer.transform(source, {
    loader,
    sourcefile: path,
    define: buildDefine(ctx.config, ctx.base),
    jsx: ctx.config.jsx,
  });
  const fromDir = dirname(path);
  return rewriteImports(code, (specifier) => mapSpecifier(ctx, fromDir, specifier));
}
