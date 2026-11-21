/**
 * Where a project's app manifest lives (PRD 49).
 *
 * Canonical: `.builderforce/builderforce.json`.
 * A root `builderforce.json` or `bfwc.app.json` left by an older version is read
 * as a fallback and never written. `manifestWritePath` is the only write target.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST_FILE = 'builderforce.json';
export const LEGACY_MANIFEST_FILES = ['builderforce.json', 'bfwc.app.json'] as const;
export const WORKSPACE_DIR = '.builderforce';

export const LEGACY_MANIFEST_DEPRECATION =
  'A root manifest is deprecated. Move it to .builderforce/builderforce.json. This launcher reads it and will not write a root manifest.';

export type ManifestLocateSource = 'file' | 'legacy' | 'missing';

export interface LocatedManifest {
  /** Absolute path. Canonical even when the file is missing. */
  path: string;
  text: string | null;
  source: ManifestLocateSource;
  /** Set only for a legacy root file. */
  deprecation?: string;
}

async function readUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Read the manifest. Canonical wins. A root file is legacy. Missing still names the canonical path. */
export async function locateManifest(root: string): Promise<LocatedManifest> {
  const canonical = join(root, WORKSPACE_DIR, MANIFEST_FILE);
  const canonicalText = await readUtf8(canonical);
  if (canonicalText !== null) return { path: canonical, text: canonicalText, source: 'file' };
  for (const name of LEGACY_MANIFEST_FILES) {
    const legacy = join(root, name);
    const text = await readUtf8(legacy);
    if (text !== null) return { path: legacy, text, source: 'legacy', deprecation: LEGACY_MANIFEST_DEPRECATION };
  }
  return { path: canonical, text: null, source: 'missing' };
}

/** The only path a writer may use. Never the project root. */
export function manifestWritePath(root: string): string {
  return join(root, WORKSPACE_DIR, MANIFEST_FILE);
}
