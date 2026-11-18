/**
 * Whether one path lies inside a directory: the ONE containment check of the
 * runtime (rooted file systems, the Security Shield's file-system views). Both
 * arguments are absolute and normalised (`normalizePath`); `/` contains every path.
 */

/** `path` is `dir` itself or lies under it. */
export function isInsideDir(path: string, dir: string): boolean {
  return dir === '/' || path === dir || path.startsWith(`${dir}/`);
}

/** `path` relative to `dir`, as an absolute path (`/` when it is `dir`); undefined when it lies outside `dir`. */
export function pathBelow(dir: string, path: string): string | undefined {
  if (dir === '/') return path;
  if (path === dir) return '/';
  return path.startsWith(`${dir}/`) ? path.slice(dir.length) : undefined;
}
