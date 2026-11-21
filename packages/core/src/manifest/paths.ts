/**
 * Project-relative workspace paths on a manifest (`paths.logs`, `paths.diagnostics`,
 * `paths.methodology`). Pure: no `node:*`, no filesystem. An absolute path or a
 * `..` segment is rejected; the caller drops that override and uses the default.
 */
export type WorkspacePathKey = 'logs' | 'diagnostics' | 'methodology';

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
