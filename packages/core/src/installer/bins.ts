/**
 * `node_modules/.bin`. The VFS has no symlinks, so each bin is a small file that
 * is both runnable JavaScript (it requires its target) and machine-readable: the
 * `@bfwc-bin` line names the target, so the shell runs the target itself as the
 * main module — CLIs that check `require.main === module` keep working.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, join, normalizePath } from '../paths.js';
import type { BinField } from './registry.js';

const MARKER = '// @bfwc-bin ';

/** `bin` as a name → relative-path map (a string `bin` is named after the package). */
export function normalizeBin(packageName: string, bin: BinField | undefined): Record<string, string> {
  if (!bin) return {};
  const entries = typeof bin === 'string' ? [[packageName.replace(/^@[^/]+\//, ''), bin]] : Object.entries(bin);
  const out: Record<string, string> = {};
  for (const [name, target] of entries) {
    const clean = name!.replace(/^@[^/]+\//, '');
    if (!clean || /[/\\]/.test(clean) || clean === '.' || clean === '..' || typeof target !== 'string') continue;
    out[clean] = target.replace(/^\.\//, '');
  }
  return out;
}

export function binShim(relativeTarget: string): string {
  return `#!/usr/bin/env node\n${MARKER}${relativeTarget}\nrequire(${JSON.stringify(relativeTarget)});\n`;
}

/** The absolute target of a `.bin` shim, or undefined when `path` is not one. */
export function readBinLink(fs: VirtualFileSystem, path: string): string | undefined {
  const text = fs.readText(path);
  if (!text) return undefined;
  const line = text.split('\n').find((l) => l.startsWith(MARKER));
  return line ? join(dirname(normalizePath(path)), line.slice(MARKER.length).trim()) : undefined;
}

/**
 * Write `<dir>/node_modules/.bin/<name>` shims for the packages in `packageDirs`
 * (absolute package directories that share that node_modules).
 */
export function linkBins(fs: VirtualFileSystem, binDir: string, packages: Array<{ dir: string; name: string; bin?: BinField }>): Record<string, string> {
  const linked: Record<string, string> = {};
  for (const pkg of packages) {
    for (const [name, target] of Object.entries(normalizeBin(pkg.name, pkg.bin))) {
      const absolute = join(pkg.dir, target);
      if (!fs.isFile(absolute)) continue;
      const relative = relativePath(binDir, absolute);
      fs.writeFile(join(binDir, name), binShim(relative));
      linked[name] = absolute;
    }
  }
  return linked;
}

export function relativePath(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split('/').filter(Boolean);
  const b = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => '..');
  const rel = [...up, ...b.slice(i)].join('/');
  return rel.startsWith('..') ? rel : `./${rel}`;
}
