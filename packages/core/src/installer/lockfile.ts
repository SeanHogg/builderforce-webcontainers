/**
 * package-lock.json, lockfileVersion 3 (npm 7+): a flat `packages` map keyed by
 * install location. Reading it lets an install skip the registry's metadata
 * entirely when nothing changed — every locked entry carries its version,
 * tarball, integrity and dependency ranges.
 */
import type { BinField, PackageManifest } from './registry.js';
import type { ResolvedPackage } from './tree.js';
import { sortObject, type PackageJson } from './spec.js';
import { satisfies, validRange } from './semver.js';

export interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  optional?: boolean;
  license?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bin?: BinField;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  hasInstallScript?: boolean;
  deprecated?: string;
}

export interface Lockfile {
  name?: string;
  version?: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockEntry>;
}

export function parseLockfile(text: string | undefined): Lockfile | undefined {
  if (!text) return undefined;
  try {
    const lock = JSON.parse(text) as Lockfile;
    // v1 lockfiles only have the nested `dependencies` tree; re-resolving is simpler than translating.
    return lock.lockfileVersion >= 2 && lock.packages ? lock : undefined;
  } catch {
    return undefined;
  }
}

const nameFromLocation = (location: string) => location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** A locked entry as the manifest the resolver works with. */
export function lockEntryManifest(location: string, entry: LockEntry): PackageManifest | undefined {
  if (!entry.version || !entry.resolved) return undefined;
  return {
    name: entry.name ?? nameFromLocation(location),
    version: entry.version,
    dependencies: entry.dependencies,
    optionalDependencies: entry.optionalDependencies,
    peerDependencies: entry.peerDependencies,
    peerDependenciesMeta: entry.peerDependenciesMeta,
    bin: entry.bin,
    engines: entry.engines,
    os: entry.os,
    cpu: entry.cpu,
    hasInstallScript: entry.hasInstallScript,
    deprecated: entry.deprecated,
    license: entry.license,
    dist: { tarball: entry.resolved, integrity: entry.integrity },
  };
}

/** Locked manifests by registry package name, for "prefer what is locked". */
export function lockedManifests(lock: Lockfile | undefined): Map<string, PackageManifest[]> {
  const out = new Map<string, PackageManifest[]>();
  for (const [location, entry] of Object.entries(lock?.packages ?? {})) {
    if (!location.includes('node_modules/')) continue;
    const manifest = lockEntryManifest(location, entry);
    if (!manifest) continue;
    const list = out.get(manifest.name) ?? [];
    list.push(manifest);
    out.set(manifest.name, list);
  }
  return out;
}

/** The highest locked version of `name` satisfying `range`, if any. */
export function pickLocked(locked: Map<string, PackageManifest[]>, name: string, range: string): PackageManifest | undefined {
  const r = range || '*';
  if (!validRange(r)) return undefined;
  let best: PackageManifest | undefined;
  for (const m of locked.get(name) ?? []) {
    if (satisfies(m.version, r) && (!best || satisfies(m.version, `>${best.version}`))) best = m;
  }
  return best;
}

const ROOT_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/** Do the lockfile's root ranges match package.json exactly? (`npm ci`'s precondition.) */
export function lockMatchesPackage(lock: Lockfile, pkg: PackageJson): boolean {
  const root = lock.packages[''] ?? {};
  return ROOT_FIELDS.every((field) => {
    const a = pkg[field] ?? {};
    const b = (root as Record<string, Record<string, string> | undefined>)[field] ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => a[k] === b[k]);
  });
}

const nonEmpty = <T extends object>(record: T | undefined): T | undefined => (record && Object.keys(record).length ? record : undefined);

export function buildLockfile(pkg: PackageJson, tree: Map<string, ResolvedPackage>): Lockfile {
  const root: LockEntry & { name?: string } = { name: pkg.name, version: pkg.version };
  for (const field of ROOT_FIELDS) if (nonEmpty(pkg[field])) (root as Record<string, unknown>)[field] = pkg[field];
  if (pkg.bin) root.bin = pkg.bin;
  const packages: Record<string, LockEntry> = { '': JSON.parse(JSON.stringify(root)) as LockEntry };

  for (const location of [...tree.keys()].sort()) {
    const node = tree.get(location)!;
    const m = node.manifest;
    const entry: LockEntry = {
      name: m.name !== node.name ? m.name : undefined,
      version: m.version,
      resolved: m.dist.tarball,
      integrity: m.dist.integrity,
      dev: node.dev || undefined,
      optional: node.optional || undefined,
      license: m.license,
      dependencies: nonEmpty(m.dependencies && sortObject(m.dependencies)),
      optionalDependencies: nonEmpty(m.optionalDependencies),
      peerDependencies: nonEmpty(m.peerDependencies),
      peerDependenciesMeta: nonEmpty(m.peerDependenciesMeta),
      bin: m.bin,
      engines: nonEmpty(m.engines),
      os: m.os,
      cpu: m.cpu,
      hasInstallScript: m.hasInstallScript || undefined,
      deprecated: m.deprecated,
    };
    packages[location] = JSON.parse(JSON.stringify(entry)) as LockEntry; // drops the undefineds
  }
  return { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
}
