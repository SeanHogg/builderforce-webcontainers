/**
 * Control 8 (make.md › PRD 31 §4 W10): what a process of an application may see
 * and change of the page's file system. The page's file system is the one
 * authority; each process holds a mirror, started from a snapshot and kept in
 * step by `fs` broadcasts (fsSync.ts, viewSupply.ts). For an application process
 * both are scoped here, and its journal is judged here before the page applies it.
 *
 * An application process's view, rooted at its service's directory (the `cwd`
 * its identity was given at spawn — `ServiceSpec.root`):
 *
 * - its service directory: read and write — except what is read-only below,
 *   and except a directory inside it that another service (of any application)
 *   is rooted at, which it may not write (nor, for another application's, read);
 * - shared dependencies at the workspace root — `node_modules`, the package
 *   manifest and lockfiles (`SHARED_DEPENDENCIES`), `tsconfig*.json`
 *   (`SHARED_NAME_PATTERNS`) — read-only, even to a service rooted at the
 *   workspace, so no application can plant code another one loads;
 * - platform paths (`/.bfwc/**`, at the file-system root and the workspace
 *   root) — read-only;
 * - the directories above those, as directories (their names only);
 * - nothing else. Deliberately NOT shared: `.npmrc` (it carries registry
 *   tokens) and `.env*` at the workspace root (confidentiality is the point).
 *
 * Known limits: "another service's directory" means one a process has been
 * started for so far (roots are learned at spawn, not from the whole spec), and
 * a process that already started keeps what its snapshot held when a foreign
 * application's directory inside its root became known.
 *
 * Every op of an application's journal is validated first (exactly the
 * journal's kinds, a string path, string or byte content): anything else is
 * refused `fs.invalid_op`. A write into a read-only path, or a remove of a
 * directory holding one, is refused `fs.protected_path`; one outside the service
 * directory (or into another service's) `fs.outside_app`. A `mkdir` of a
 * directory above the service directory is a no-op: never applied, never
 * broadcast. Processes with the `workspace` identity are not scoped.
 */
import { ALLOW, deny, dirname, basename, isInsideDir, join, normalizePath, type ShieldDecision, type VfsOp } from '@seanhogg/builderforce-webcontainers-core';

/** Read-only to applications, relative to the workspace root: what installs write and every service resolves. */
export const SHARED_DEPENDENCIES: readonly string[] = Object.freeze([
  'node_modules',
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]);

/** Files directly in the workspace root shared read-only by name: the TypeScript configs services extend. */
export const SHARED_NAME_PATTERNS: readonly RegExp[] = Object.freeze([/^tsconfig(?:\..*)?\.json$/]);

export interface FsScopeOptions {
  /** The project's directory in the process host's file system (`ProcessHostOptions.cwd`). */
  workspaceRoot: string;
  /** Platform paths, read-only to every application (absolute). Default `/.bfwc` and `<workspaceRoot>/.bfwc`. */
  protectedPaths?: readonly string[];
  /** Shared dependencies, read-only to applications, relative to the workspace root. Default `SHARED_DEPENDENCIES`. */
  sharedPaths?: readonly string[];
  /** Names of files in the workspace root shared read-only. Default `SHARED_NAME_PATTERNS`. */
  sharedNamePatterns?: readonly RegExp[];
}

/** What the page does with one op of an application's journal: apply it, refuse it, or drop it as changing nothing. */
export type OpVerdict = ShieldDecision | 'noop';

/** One application service's view of the file system. */
export interface FsView {
  readonly applicationId: string;
  /** The service directory. */
  readonly root: string;
  /** Bumped when what the view may see changed (another application's directory inside it became known). */
  readonly revision: number;
  /** Whether the process may see `path` (in its snapshot, in the page's broadcasts). */
  visible(path: string): boolean;
  /** Whether the page applies this op (already `isJournalOp`) from the process's journal. */
  judge(op: VfsOp): OpVerdict;
}

/** Exactly the journal's op kinds, with a string path and (for a write) string or byte content. */
export function isJournalOp(op: unknown): op is VfsOp {
  if (typeof op !== 'object' || op === null) return false;
  const { op: kind, path, content } = op as { op?: unknown; path?: unknown; content?: unknown };
  if (typeof path !== 'string' || path === '') return false;
  if (kind === 'write') return typeof content === 'string' || content instanceof Uint8Array;
  return kind === 'remove' || kind === 'mkdir';
}

/** `inner` lies strictly inside `outer`. */
const strictlyInside = (inner: string, outer: string) => inner !== outer && isInsideDir(inner, outer);

interface MutableView extends FsView {
  revision: number;
}

export class FsScopes {
  private readonly workspace: string;
  private readonly protectedPaths: readonly string[];
  private readonly sharedPaths: readonly string[];
  private readonly sharedNames: readonly RegExp[];
  private readonly views = new Map<string, MutableView>();

  constructor(options: FsScopeOptions) {
    this.workspace = normalizePath(options.workspaceRoot);
    this.protectedPaths = [...new Set((options.protectedPaths ?? ['/.bfwc', join(this.workspace, '.bfwc')]).map(normalizePath))];
    this.sharedPaths = (options.sharedPaths ?? SHARED_DEPENDENCIES).map((path) => join(this.workspace, path));
    this.sharedNames = options.sharedNamePatterns ?? SHARED_NAME_PATTERNS;
  }

  /** The view of a process of `applicationId` whose service directory is `root`. */
  view(applicationId: string, root: string): FsView {
    const at = normalizePath(root);
    const key = `${applicationId}\n${at}`;
    let view = this.views.get(key);
    if (view) return view;
    view = this.create(applicationId, at);
    // A view of another application already rooted above this directory no longer sees it.
    for (const other of this.views.values()) if (other.applicationId !== applicationId && strictlyInside(at, other.root)) other.revision++;
    this.views.set(key, view);
    return view;
  }

  private isReadOnly(path: string): boolean {
    return this.protectedPaths.some((dir) => isInsideDir(path, dir)) || this.isShared(path);
  }

  private isShared(path: string): boolean {
    if (this.sharedPaths.some((dir) => isInsideDir(path, dir))) return true;
    return dirname(path) === this.workspace && path !== this.workspace && this.sharedNames.some((pattern) => pattern.test(basename(path)));
  }

  /** Other services' directories strictly inside `root` (of other applications only, when `foreignOnly`). */
  private nestedRoots(applicationId: string, root: string, foreignOnly: boolean): string[] {
    const roots: string[] = [];
    for (const other of this.views.values()) {
      if (foreignOnly && other.applicationId === applicationId) continue;
      if (strictlyInside(other.root, root)) roots.push(other.root);
    }
    return roots;
  }

  private create(applicationId: string, root: string): MutableView {
    const readable = [root, ...this.protectedPaths, ...this.sharedPaths];
    const scopes = this;
    return {
      applicationId,
      root,
      revision: 0,
      visible(path) {
        if (scopes.nestedRoots(applicationId, root, true).some((dir) => isInsideDir(path, dir))) return false;
        return readable.some((dir) => isInsideDir(path, dir) || isInsideDir(dir, path)) || scopes.isShared(path);
      },
      judge(op) {
        const path = normalizePath(op.path);
        if (scopes.isReadOnly(path)) return deny('fs.protected_path');
        // Making a directory above its own explicit changes nothing anyone reads: dropped.
        if (op.op === 'mkdir' && strictlyInside(root, path)) return 'noop';
        if (op.op === 'remove') {
          const held = [...scopes.protectedPaths, ...scopes.sharedPaths];
          if (held.some((dir) => isInsideDir(dir, path)) || (path === scopes.workspace || isInsideDir(scopes.workspace, path))) return deny('fs.protected_path');
        }
        // Another service's directory: never written into, never removed with a directory above it.
        const nested = scopes.nestedRoots(applicationId, root, false);
        if (nested.some((dir) => isInsideDir(path, dir) || (op.op === 'remove' && isInsideDir(dir, path)))) return deny('fs.outside_app');
        return isInsideDir(path, root) ? ALLOW : deny('fs.outside_app');
      },
    };
  }
}
