/**
 * Project-relative workspace paths on a manifest (`paths.logs`, `paths.diagnostics`,
 * `paths.methodology`). Pure: no `node:*`, no filesystem. An absolute path or a
 * `..` segment is rejected; the caller drops that override and uses the default.
 */
export type WorkspacePathKey = 'logs' | 'diagnostics' | 'methodology';

/** Every `paths` key, in a stable order. */
export const WORKSPACE_PATH_KEYS: readonly WorkspacePathKey[] = ['logs', 'diagnostics', 'methodology'];

/** Why each rejected path is rejected, in a sentence. */
export const PATH_ISSUE_DETAIL: Readonly<Record<PathIssueCode, string>> = {
  'path-absolute': 'It is absolute.',
  'path-parent': 'It has a ".." segment.',
  'path-empty': 'It is empty.',
};

export interface ManifestPaths {
  logs?: string;
  diagnostics?: string;
  methodology?: string;
}

export type PathIssueCode =
  | 'path-absolute' // starts with / or a drive prefix
  | 'path-parent' // contains a .. segment
  | 'path-empty';

export interface PathIssue {
  code: PathIssueCode;
  key: WorkspacePathKey;
  value: string;
}

const DRIVE_PREFIX = /^[A-Za-z]:/;

/**
 * Pure. Rejects an empty path, an absolute path (leading `/` or `\`, or a drive
 * prefix such as `C:`), and any `..` segment. Does not touch the filesystem.
 * Returns null when the path may be used as a project-relative override.
 */
export function validateWorkspacePath(value: string): PathIssueCode | null {
  const path = value.trim();
  if (path === '') return 'path-empty';
  if (path.startsWith('/') || path.startsWith('\\') || DRIVE_PREFIX.test(path)) return 'path-absolute';
  if (path.split(/[/\\]/).some((segment) => segment === '..')) return 'path-parent';
  return null;
}

/**
 * The overrides of `paths` that may be used: each valid string entry; an absent,
 * non-string, unknown, empty, absolute or `..` entry is left out (its default
 * applies). `validateManifest` reports what was left out.
 */
export function usableWorkspacePaths(paths: unknown): ManifestPaths {
  const usable: ManifestPaths = {};
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return usable;
  for (const key of WORKSPACE_PATH_KEYS) {
    const value = (paths as Record<string, unknown>)[key];
    if (typeof value === 'string' && validateWorkspacePath(value) === null) usable[key] = value.trim();
  }
  return usable;
}
