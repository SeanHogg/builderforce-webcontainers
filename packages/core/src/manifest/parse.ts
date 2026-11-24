/**
 * `parseManifest`: the one reader of `builderforce.json`, for the standalone
 * runtime, the API, the web app and the VSIX. An unreadable file is reported,
 * never dropped. A file without `version` is the unversioned legacy format
 * (Builderforce's partial `AppBlueprint`): core does not interpret it, it hands
 * the parsed object back as `legacy` for the host's adapter to map.
 */
import { manifestIssue, type ManifestIssue } from './issues.js';
import { isRecord } from './overrides.js';
import { usableWorkspacePaths } from './paths.js';
import type { AppManifest } from './types.js';
import { validateManifest, type ValidateManifestOptions } from './validate.js';

export interface ManifestParseResult {
  /** The v1 manifest, also when it has validation issues; null when the file is unreadable, legacy or another version. */
  manifest: AppManifest | null;
  /** The parsed object of an unversioned (legacy) file, for the host to map. */
  legacy?: Record<string, unknown>;
  issues: ManifestIssue[];
}

export function parseManifest(text: string, options: ValidateManifestOptions = {}): ManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    return { manifest: null, issues: [manifestIssue('invalid-json', '', { detail: error instanceof Error ? error.message : String(error) })] };
  }
  if (!isRecord(parsed)) return { manifest: null, issues: [manifestIssue('not-an-object', '')] };
  if (parsed.version === undefined) return { manifest: null, legacy: parsed, issues: [manifestIssue('legacy-format', 'version', { severity: 'info' })] };
  if (parsed.version !== 1) return { manifest: null, issues: [manifestIssue('unsupported-version', 'version', { value: JSON.stringify(parsed.version) })] };
  const issues = validateManifest(parsed as unknown as AppManifest, options);
  // A bad `paths` override is reported (above) and left out, so every reader gets the default for it.
  if (parsed.paths === undefined) return { manifest: parsed as unknown as AppManifest, issues };
  const { paths: given, ...rest } = parsed;
  const paths = usableWorkspacePaths(given);
  const manifest = (Object.keys(paths).length ? { ...rest, paths } : rest) as unknown as AppManifest;
  return { manifest, issues };
}
