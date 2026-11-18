import type { VirtualFileSystem } from './vfs.js';
import { join, normalizePath } from './paths.js';

/**
 * Files served as-is from the site, outside the module graph: Vite/CRA's
 * `public/`, Angular's `assets`. `from` is a VFS directory or a single file, `to`
 * the URL path (under the base) it appears at.
 */
export interface StaticDir {
  from: string;
  to: string;
}

/** Vite / CRA: `public/` at the site root. */
export const PUBLIC_DIR: readonly StaticDir[] = [{ from: '/public', to: '/' }];

/** The URL path under `dir.to` that `urlPath` names, relative (`''` for `to` itself), or undefined. */
function under(dir: StaticDir, urlPath: string): string | undefined {
  const to = normalizePath(dir.to);
  if (urlPath === to) return '';
  const prefix = to === '/' ? '/' : `${to}/`;
  return urlPath.startsWith(prefix) ? urlPath.slice(prefix.length) : undefined;
}

/** The VFS file a site URL path (`/favicon.ico`) is served from, or undefined. */
export function resolveStaticFile(fs: VirtualFileSystem, dirs: readonly StaticDir[], urlPath: string): string | undefined {
  const path = normalizePath(urlPath);
  for (const dir of dirs) {
    const rest = under(dir, path);
    if (rest === undefined) continue;
    const file = rest ? join(dir.from, rest) : normalizePath(dir.from);
    if (fs.isFile(file)) return file;
  }
  return undefined;
}

/** Every static file with its output path relative to the site root (`assets/logo.svg`). Later dirs win. */
export function listStaticFiles(fs: VirtualFileSystem, dirs: readonly StaticDir[]): Map<string, string> {
  const out = new Map<string, string>();
  const paths = fs.list();
  for (const dir of dirs) {
    const from = normalizePath(dir.from);
    const to = normalizePath(dir.to).slice(1);
    for (const path of paths) {
      if (path === from) out.set(to, path);
      else if (path.startsWith(from === '/' ? '/' : `${from}/`)) out.set(join(to, path.slice(from.length)).slice(1), path);
    }
  }
  return out;
}
