/**
 * Choosing package versions for `composer install` without a lock file,
 * `update` and `require`. Not Composer's SAT solver, but a complete
 * backtracking search over the same rules:
 *
 * - the requirements in force are rebuilt at every step from the root and the
 *   packages chosen on that branch only — a version dropped by backtracking
 *   takes its constraints with it;
 * - each package is tried best-first (highest version allowed by every
 *   constraint on it, preferring stable under `prefer-stable`, never below
 *   `minimum-stability` unless a constraint's own stability allows it; a
 *   `preferred` version — the lock's, for `update vendor/pkg` — first), and a
 *   version whose subtree fails is excluded on that branch and the next is
 *   tried (`a/a 2.0` needing `c ^2` gives way to `a/a 1.0` when `b/b` needs
 *   `a ^1`);
 * - a candidate whose platform requirements the running PHP cannot meet
 *   (platform.ts) is skipped, so an older release that still supports it wins;
 * - virtual and replaced packages are satisfied by whichever chosen package (or
 *   the root) `provide`s or `replace`s them; `conflict` rules out the
 *   conflicting versions.
 *
 * A failure reports the constraints that clash on the package that could not
 * be placed. The search is bounded (steps), never unbounded time.
 */
import { checkPackageName } from './packageName.js';
import type { PackageSource, PackageVersion } from './packagist.js';
import { isPlatformPackage, platformShortfall, type Platform } from './platform.js';
import { compareVersions, parseConstraint, parseVersion, stabilityAtLeast, type Constraint, type Stability, type Version } from './semver.js';

export interface ResolveOptions {
  minimumStability: Stability;
  preferStable: boolean;
  /** The running PHP: candidates whose platform requirements it cannot meet are skipped. Omit to ignore platform requirements. */
  platform?: Platform;
  /** Versions to try first, by package name (the lock's, for a partial update). */
  preferred?: ReadonlyMap<string, string>;
  /** Steps before the search gives up. Default 20,000. */
  maxSteps?: number;
}

export interface Resolution {
  /** The chosen version of every package, by name. */
  packages: Map<string, PackageVersion>;
}

export interface Requirement {
  name: string;
  constraint: string;
  /** Who asked (`root`, or `vendor/pkg`), for conflict reports. */
  from: string;
}

/** What the root package itself satisfies and rules out. */
export interface RootLinks {
  replace?: Record<string, string>;
  provide?: Record<string, string>;
  conflict?: Record<string, string>;
}

export class ResolveError extends Error {}

const versionOf = (pkg: PackageVersion): Version | undefined => parseVersion(pkg.version_normalized ?? pkg.version);

/** A package's requirements; a name the repository gave that is not a Composer name is refused (packageName.ts). */
const requirementsOf = (pkg: PackageVersion): Requirement[] => Object.entries(pkg.require ?? {}).map(([name, constraint]) => ({ name: checkPackageName(name, `${pkg.name}'s require`), constraint, from: pkg.name }));

const linkNames = (links: Pick<RootLinks, 'replace' | 'provide'>) => [...Object.keys(links.replace ?? {}), ...Object.keys(links.provide ?? {})].map((key) => key.toLowerCase());

/** The best version of `versions` under `constraints`. */
export function pickVersion(versions: readonly PackageVersion[], constraints: readonly Constraint[], options: Pick<ResolveOptions, 'minimumStability' | 'preferStable'>): PackageVersion | undefined {
  return rankVersions(versions, constraints, options)[0];
}

/** Every version of `versions` allowed by `constraints`, best first. */
export function rankVersions(versions: readonly PackageVersion[], constraints: readonly Constraint[], options: Pick<ResolveOptions, 'minimumStability' | 'preferStable'>, preferred?: string): PackageVersion[] {
  const allowed = constraints.reduce<Stability>((minimum, constraint) => (constraint.stability && stabilityAtLeast({ parts: [], stability: minimum, pre: 0 }, constraint.stability) ? constraint.stability : minimum), options.minimumStability);
  const candidates = versions
    .map((pkg) => ({ pkg, version: versionOf(pkg) }))
    .filter((entry): entry is { pkg: PackageVersion; version: Version } => !!entry.version && stabilityAtLeast(entry.version, allowed) && constraints.every((constraint) => constraint.test(entry.version!)))
    .sort((a, b) => compareVersions(b.version, a.version));
  const ranked = options.preferStable ? [...candidates.filter((entry) => entry.version.stability === 'stable'), ...candidates.filter((entry) => entry.version.stability !== 'stable')] : candidates;
  const first = preferred === undefined ? -1 : ranked.findIndex((entry) => entry.pkg.version === preferred);
  if (first > 0) ranked.unshift(...ranked.splice(first, 1));
  return ranked.map((entry) => entry.pkg);
}

function parsedConstraints(name: string, requirements: readonly Requirement[]): Constraint[] {
  return requirements.map((entry) => {
    const parsed = parseConstraint(entry.constraint);
    if (!parsed) throw new ResolveError(`Cannot read the version constraint "${entry.constraint}" on ${name} (required by ${entry.from}).`);
    return parsed;
  });
}

export async function resolvePackages(root: readonly Requirement[], source: PackageSource, options: ResolveOptions, rootLinks: RootLinks = {}): Promise<Resolution> {
  const rootStandsIn = new Set(linkNames(rootLinks));
  const budget = { steps: options.maxSteps ?? 20_000 };
  /** The deepest failure seen, for the report. */
  let failure = '';
  const versions = new Map<string, PackageVersion[] | undefined>();
  const versionsOf = async (name: string) => {
    if (!versions.has(name)) versions.set(name, await source.versions(name));
    return versions.get(name);
  };

  const conflicts = (chosen: ReadonlyMap<string, PackageVersion>): string | undefined => {
    const rules = [{ from: 'root', conflict: rootLinks.conflict }, ...[...chosen.values()].map((pkg) => ({ from: pkg.name, conflict: pkg.conflict as Record<string, string> | undefined }))];
    for (const { from, conflict } of rules) {
      for (const [name, constraint] of Object.entries(conflict ?? {})) {
        const target = chosen.get(name.toLowerCase());
        const version = target && versionOf(target);
        if (version && parseConstraint(constraint)?.test(version)) return `${from} conflicts with ${target!.name} ${constraint}`;
      }
    }
    return undefined;
  };

  const solve = async (chosen: Map<string, PackageVersion>): Promise<Map<string, PackageVersion> | undefined> => {
    if (--budget.steps < 0) throw new ResolveError('Dependency resolution took too long; pin the conflicting packages in composer.json.');
    // The requirements in force: the root's and those of the packages chosen on this branch — nothing else.
    const byName = new Map<string, Requirement[]>();
    for (const requirement of [...root, ...[...chosen.values()].flatMap(requirementsOf)]) {
      if (isPlatformPackage(requirement.name)) continue;
      byName.set(requirement.name, [...(byName.get(requirement.name) ?? []), requirement]);
    }
    const standing = new Set([...rootStandsIn, ...[...chosen.values()].flatMap(linkNames)]);
    for (const [name, pkg] of chosen) {
      const requirements = byName.get(name) ?? [];
      const version = versionOf(pkg)!;
      const parsed = parsedConstraints(name, requirements);
      const broken = requirements.find((_, index) => !parsed[index]!.test(version));
      if (broken) {
        failure = `${name} ${pkg.version} was chosen, but ${broken.from} requires ${name} ${broken.constraint}.`;
        return undefined;
      }
    }
    const conflict = conflicts(chosen);
    if (conflict) {
      failure = `${conflict}.`;
      return undefined;
    }
    const open = [...byName.keys()].filter((name) => !chosen.has(name) && !standing.has(name));
    let next: string | undefined;
    for (const name of open) {
      if (await versionsOf(name)) {
        next = name;
        break;
      }
    }
    if (next === undefined) {
      if (!open.length) return chosen;
      const missing = open[0]!;
      failure = `Package ${missing} (required by ${byName.get(missing)!.map((entry) => entry.from).join(', ')}) was not found in the repository, and no chosen package provides or replaces it.`;
      return undefined;
    }
    const requirements = byName.get(next)!;
    const candidates = rankVersions((await versionsOf(next))!, parsedConstraints(next, requirements), options, options.preferred?.get(next));
    if (!candidates.length) {
      failure = `No version of ${next} satisfies ${requirements.map((entry) => `${entry.constraint} (required by ${entry.from})`).join(' and ')} at minimum-stability ${options.minimumStability}.`;
      return undefined;
    }
    for (const candidate of candidates) {
      const shortfall = options.platform && Object.entries(candidate.require ?? {}).map(([name, constraint]) => (isPlatformPackage(name.toLowerCase()) ? platformShortfall(name, constraint, options.platform!) : undefined)).find(Boolean);
      if (shortfall) {
        failure = `${candidate.name} ${candidate.version} is declined: ${shortfall}`;
        continue;
      }
      const solved = await solve(new Map([...chosen, [next, candidate]]));
      if (solved) return solved;
    }
    return undefined;
  };

  const solved = await solve(new Map());
  if (!solved) throw new ResolveError(failure || 'No installable set of packages satisfies composer.json.');
  return { packages: solved };
}

/** The root package's requirements (`require`, and `require-dev` unless `noDev`). */
export function rootRequirements(composer: { require?: Record<string, string>; 'require-dev'?: Record<string, string> }, noDev: boolean): Requirement[] {
  const entries = [...Object.entries(composer.require ?? {}), ...(noDev ? [] : Object.entries(composer['require-dev'] ?? {}))];
  return entries.map(([name, constraint]) => ({ name: name.toLowerCase(), constraint, from: 'root' }));
}
