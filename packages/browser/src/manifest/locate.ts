/**
 * Where a project's app manifest lives (PRD 49).
 *
 * Canonical: `.builderforce/builderforce.json`.
 * A root `builderforce.json` or `bfwc.app.json` left by an older version is read
 * as a fallback and never written. `manifestWritePath` is the only write target.
 *
 * A candidate that is not there — absent, a path through a file (`ENOTDIR`), a
 * directory (`EISDIR`) — is missing and the next one is tried. A candidate whose
 * real path leaves the project (a symlinked `.builderforce`, a linked manifest) is
 * refused and never read: `outside` says so. One that is there but cannot be read
 * (no permission, too big, changed while read) stops the search: `unreadable` says
 * why, so a stale root file is never read in its place.
 */
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { containedFile, readContained } from '../shared/containedFile.js';

export const MANIFEST_FILE = 'builderforce.json';
export const LEGACY_MANIFEST_FILES = ['builderforce.json', 'bfwc.app.json'] as const;
export const WORKSPACE_DIR = '.builderforce';

/** The largest manifest read (a manifest is a few KB; anything this big is not one). */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

/**
 * For API consumers (`LocatedManifest.deprecation`, `LaunchInfo.deprecation`): the
 * launcher page shows its own overridable label (`legacyManifestLocation`) instead.
 */
export const LEGACY_MANIFEST_DEPRECATION =
  'A root manifest is deprecated. Move it to .builderforce/builderforce.json. This launcher reads it and will not write a root manifest.';

export type ManifestLocateSource = 'file' | 'legacy' | 'missing';

export interface LocatedManifest {
  /** Absolute path. Canonical even when the file is missing; the refused file's when `outside`. */
  path: string;
  text: string | null;
  source: ManifestLocateSource;
  /** Set only for a legacy root file. */
  deprecation?: string;
  /** The manifest at `path` resolves outside the project: refused, not read (`text` is null, `source` `missing`). */
  outside?: true;
  /** A manifest is at `path` but could not be read (no permission, over {@link MANIFEST_MAX_BYTES}, changed while read): reported, never skipped for the next candidate. */
  unreadable?: string;
}

/** "No file here": the next candidate is tried. Every other failure is reported. */
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

/** Why `path` cannot be resolved, or null when it simply is not there. */
async function resolveError(path: string): Promise<string | null> {
  try {
    await realpath(path);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    return NOT_THERE.has(code) ? null : error instanceof Error ? error.message : String(error);
  }
}

/** Read the manifest. Canonical wins. A root file is legacy. Missing still names the canonical path. */
export async function locateManifest(root: string): Promise<LocatedManifest> {
  const realRoot = await realpath(root);
  const candidates: { path: string; legacy: boolean }[] = [
    { path: join(root, WORKSPACE_DIR, MANIFEST_FILE), legacy: false },
    ...LEGACY_MANIFEST_FILES.map((name) => ({ path: join(root, name), legacy: true })),
  ];
  for (const candidate of candidates) {
    // Contained, like every project file the launcher reads: resolved against the real root, re-checked after the read.
    const file = await containedFile(realRoot, candidate.path);
    if (file === 'outside') return { path: candidate.path, text: null, source: 'missing', outside: true };
    if (file === 'directory') continue; // EISDIR: not a manifest
    if (file === null) {
      // Absent, or a path through a file (ENOTDIR): the next candidate. Anything else (EACCES, a loop) is reported, never skipped.
      const reason = await resolveError(candidate.path);
      if (reason === null) continue;
      return { path: candidate.path, text: null, source: 'missing', unreadable: reason };
    }
    // A manifest IS here: if it cannot be read, say so — never fall back to a stale root file or to "no manifest".
    if (file.size > MANIFEST_MAX_BYTES) return { path: candidate.path, text: null, source: 'missing', unreadable: `It is over ${MANIFEST_MAX_BYTES} bytes.` };
    const bytes = await readContained(realRoot, candidate.path, file, MANIFEST_MAX_BYTES);
    if (bytes === null) return { path: candidate.path, text: null, source: 'missing', unreadable: 'It changed while it was read.' };
    const text = new TextDecoder().decode(bytes);
    return candidate.legacy ? { path: candidate.path, text, source: 'legacy', deprecation: LEGACY_MANIFEST_DEPRECATION } : { path: candidate.path, text, source: 'file' };
  }
  return { path: join(root, WORKSPACE_DIR, MANIFEST_FILE), text: null, source: 'missing' };
}

/** The only path a writer may use. Never the project root. */
export function manifestWritePath(root: string): string {
  return join(root, WORKSPACE_DIR, MANIFEST_FILE);
}
