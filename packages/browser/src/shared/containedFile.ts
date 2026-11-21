/**
 * Reading a file only while it stays inside a root directory (Node only — never
 * imported by browser entry points). The ONE home for it: the launcher's project
 * file API (`launcher/server/projectFiles.ts`) and the manifest locator
 * (`manifest/locate.ts`) read through it; the .NET bundle (`dotnetBundle.ts`) uses
 * its `isInside`.
 *
 * Every path is resolved (symlinks included) against the root's real path; one
 * that lands outside is refused. The check is repeated after reading
 * ({@link readContained}), so a link swapped in between the check and the read
 * is never returned.
 */
import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

/** Whether `target` is `root` or inside it (both real, absolute paths). */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Where `path` really is when it is a file inside `root`: null when it is outside, a directory, or gone. */
export async function containedFile(root: string, absolute: string): Promise<{ real: string; size: number } | 'outside' | 'directory' | null> {
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return null;
  }
  if (!isInside(root, real)) return 'outside';
  const info = await stat(real).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return 'directory';
  return info.isFile() ? { real, size: info.size } : null;
}

/** Open without following a final symlink, where the platform can (`O_NOFOLLOW`; not on Windows). */
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/**
 * Read `file` (from {@link containedFile}) without trusting that it stayed put: open
 * its real path without following a final link, check the open file is still a
 * regular file within `maxBytes`, read it, then resolve `absolute` again — it must
 * still be the same file (device and inode) at the same real path inside `root`.
 * Null when anything moved in between (a link swapped in, a file replaced): the
 * caller lists it as skipped.
 */
export async function readContained(root: string, absolute: string, file: { real: string }, maxBytes: number): Promise<Uint8Array | null> {
  let handle: FileHandle;
  try {
    handle = await open(file.real, NO_FOLLOW);
  } catch {
    return null; // gone, or a link where the file was: not read
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) return null;
    const again = await realpath(absolute).catch(() => null);
    if (again !== file.real || !isInside(root, again)) return null;
    const now = await stat(again).catch(() => null);
    if (!now || now.dev !== opened.dev || now.ino !== opened.ino) return null;
    return bytes;
  } finally {
    await handle.close();
  }
}

