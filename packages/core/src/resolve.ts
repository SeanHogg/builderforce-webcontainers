import type { VirtualFileSystem } from './vfs.js';
import type { PathAlias } from './projectConfig.js';
import { extname, join, normalizePath } from './paths.js';

/** Extensions probed, in order, for an extension-less import — Vite's default order. */
export const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs', '.json', '.css'] as const;

/** `foo`, `@scope/foo`, `foo/sub` — not relative, not absolute, not a URL. */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(specifier);
}

/** Split a bare specifier into its package name and subpath (`/client`, or `''`). */
export function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split('/');
  const take = specifier.startsWith('@') ? 2 : 1;
  return { name: parts.slice(0, take).join('/'), subpath: parts.length > take ? '/' + parts.slice(take).join('/') : '' };
}

function probe(fs: VirtualFileSystem, base: string): string | undefined {
  if (fs.isFile(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) if (fs.isFile(base + ext)) return base + ext;
  // TypeScript ESM convention: `./util.js` written in source names `util.ts`.
  const ext = extname(base);
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs') {
    const stem = base.slice(0, -ext.length);
    for (const alt of ['.ts', '.tsx']) if (fs.isFile(stem + alt)) return stem + alt;
  }
  if (fs.isDirectory(base)) {
    for (const ext2 of RESOLVE_EXTENSIONS) {
      const index = join(base, 'index' + ext2);
      if (fs.isFile(index)) return index;
    }
  }
  return undefined;
}

/** Resolve a relative or absolute specifier against the importing file's directory. */
export function resolveLocal(fs: VirtualFileSystem, fromDir: string, specifier: string): string | undefined {
  const base = specifier.startsWith('/') ? normalizePath(specifier) : join(fromDir, specifier);
  return probe(fs, base);
}

/**
 * Resolve a specifier through tsconfig `paths` (`@/components/Button` →
 * `/src/components/Button.tsx`). Undefined when no alias matches or no target exists.
 */
export function resolveAlias(fs: VirtualFileSystem, aliases: readonly PathAlias[], specifier: string): string | undefined {
  for (const alias of aliases) {
    const matches = alias.wildcard ? specifier.startsWith(alias.prefix) : specifier === alias.prefix;
    if (!matches) continue;
    const rest = alias.wildcard ? specifier.slice(alias.prefix.length) : '';
    for (const target of alias.targets) {
      const hit = probe(fs, normalizePath(target + rest));
      if (hit) return hit;
    }
  }
  return undefined;
}
