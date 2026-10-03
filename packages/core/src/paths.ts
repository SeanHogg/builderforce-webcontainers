/**
 * POSIX path helpers for the virtual file system. Every path the runtime stores is
 * absolute and normalised (`/src/App.tsx`), so comparisons are plain string equality.
 */

/** Absolute, normalised: resolves `.`/`..`, collapses slashes, accepts backslashes. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return '/' + parts.join('/');
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const cut = normalized.lastIndexOf('/');
  return cut <= 0 ? '/' : normalized.slice(0, cut);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function join(...segments: string[]): string {
  return normalizePath(segments.join('/'));
}

/** Lower-cased extension including the dot (`.tsx`), or `''`. Dotfiles have none. */
export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}
