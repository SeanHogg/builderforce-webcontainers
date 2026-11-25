/**
 * The project tree the launcher hands its page (`/__bf/files`) and each changed
 * file (`/__bf/changes`): read-only, bounded, and contained.
 *
 * - Excluded directories ({@link EXCLUDED_DIRECTORIES}) are never read, wherever they sit.
 * - Caps ({@link PROJECT_LIMITS}): files over the per-file size, past the file count or
 *   past the total are listed in `skipped`, never dropped silently.
 * - Containment: every path is resolved (symlinks included) against the project's real
 *   path; one that lands outside it is refused (listed in `skipped`). A link to a
 *   directory is never followed (it could loop), and is listed too. The check is
 *   repeated after reading ({@link readContained}), so a link swapped in between
 *   the check and the read is never sent.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { containedFile, isInside, readContained } from '../../shared/containedFile.js';
import { EXCLUDED_DIRECTORIES, PROJECT_LIMITS, type ProjectChange, type ProjectSnapshot } from '../protocol.js';

export type ProjectLimits = { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

const EXCLUDED: ReadonlySet<string> = new Set(EXCLUDED_DIRECTORIES);
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The directory names never read or watched: {@link EXCLUDED_DIRECTORIES} plus the integrator's `extra`.
 * Each extra is one path segment (no `/`, `\` or `..`); anything else throws.
 */
export function resolveExcludedDirectories(extra: readonly string[] = []): ReadonlySet<string> {
  for (const name of extra) {
    if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error(`ignoredDirs: "${name}" is not a single directory name.`);
  }
  return extra.length === 0 ? EXCLUDED : new Set([...EXCLUDED_DIRECTORIES, ...extra]);
}

/** Whether a project-relative path (`/`-separated) lies in an excluded directory. */
export function isExcludedPath(path: string, excluded: ReadonlySet<string> = EXCLUDED): boolean {
  const segments = path.split('/');
  return segments.slice(0, -1).some((segment) => excluded.has(segment)) || excluded.has(segments[segments.length - 1] ?? '');
}

/** A project-relative path from an OS one (`a\b` → `a/b`). */
export function toProjectPath(osRelative: string): string {
  return osRelative.split(sep).join('/').replace(/^\/+/, '');
}

/** UTF-8 text when the bytes are valid UTF-8 without NUL; else base64. */
export function encodeFile(bytes: Uint8Array): { content: string } | { base64: string } {
  if (!bytes.includes(0)) {
    try {
      return { content: utf8.decode(bytes) };
    } catch {
      // Not UTF-8: sent as bytes below.
    }
  }
  return { base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') };
}

/**
 * Read the tree under `projectDir`. `root` must be its real path (`realpath`), so
 * containment compares like with like.
 */
export async function readProjectTree(root: string, limits: ProjectLimits = PROJECT_LIMITS, excluded: ReadonlySet<string> = EXCLUDED): Promise<ProjectSnapshot> {
  const snapshot: ProjectSnapshot = { files: {}, binary: {}, skipped: [] };
  let count = 0;
  let total = 0;

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = toProjectPath(relative(root, absolute));
      if (entry.isDirectory()) {
        if (!excluded.has(entry.name)) await visit(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, devices, FIFOs
      if (entry.isSymbolicLink() && excluded.has(entry.name)) continue;
      const file = await containedFile(root, absolute);
      if (file === null) continue; // a dangling link: nothing to send
      if (file === 'outside' || file === 'directory') {
        snapshot.skipped.push(path);
        continue;
      }
      if (file.size > limits.maxFileBytes || count >= limits.maxFiles || total + file.size > limits.maxTotalBytes) {
        snapshot.skipped.push(path);
        continue;
      }
      const bytes = await readContained(root, absolute, file, Math.min(limits.maxFileBytes, limits.maxTotalBytes - total));
      if (!bytes) {
        snapshot.skipped.push(path); // it changed while being read (a link swapped in, a file replaced, grown past a cap)
        continue;
      }
      const encoded = encodeFile(bytes);
      count++;
      total += bytes.byteLength;
      if ('content' in encoded) snapshot.files[path] = encoded.content;
      else snapshot.binary[path] = encoded.base64;
    }
  }

  await visit(root);
  return snapshot;
}

/**
 * One changed path as a {@link ProjectChange}; null when there is nothing to send (an
 * excluded path, a directory). A path that no longer exists is `deleted`.
 */
export async function readProjectChange(root: string, path: string, limits: ProjectLimits = PROJECT_LIMITS, excluded: ReadonlySet<string> = EXCLUDED): Promise<ProjectChange | null> {
  if (!path || isExcludedPath(path, excluded)) return null;
  const absolute = join(root, ...path.split('/'));
  if (!isInside(root, absolute)) return null;
  const exists = await lstat(absolute).then(() => true, () => false);
  if (!exists) return { path, deleted: true };
  const file = await containedFile(root, absolute);
  if (file === 'directory') return null;
  if (file === null) return { path, deleted: true };
  if (file === 'outside' || file.size > limits.maxFileBytes) return { path, skipped: true };
  const bytes = await readContained(root, absolute, file, limits.maxFileBytes);
  return bytes ? { path, ...encodeFile(bytes) } : { path, skipped: true };
}
