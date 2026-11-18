/**
 * Composer's versions and constraints, as the PHP runtime's installer needs
 * them: normalized versions (`1.2.3.0`, `1.2.3.0-beta1`, `dev-main`),
 * stabilities (stable > RC > beta > alpha > dev), and constraint strings —
 * `||`/`|` alternatives of `,`/space conjunctions of `*`, `1.2.*`, `^1.2`,
 * `~1.2.3`, `>=1.0`, `<2.0`, `!=1.5`, exact versions, hyphen ranges
 * (`1.0 - 2.0`), `dev-<branch>` and `@stability` flags. Bounds follow
 * Composer: a lower bound or an upper `<` bound means `-dev` of that version,
 * so `<2.0` excludes 2.0's pre-releases. Pure.
 */

export type Stability = 'stable' | 'RC' | 'beta' | 'alpha' | 'dev';

const RANK: Record<Stability, number> = { dev: 0, alpha: 1, beta: 2, RC: 3, stable: 4 };

export interface Version {
  /** Four numeric parts; a branch has none. */
  parts: number[];
  stability: Stability;
  /** The pre-release number (`beta2` → 2). */
  pre: number;
  /** A `dev-<name>` branch: equal only to itself. */
  branch?: string;
}

const STABILITY_SUFFIX = /^[._-]?(stable|beta|b|RC|rc|alpha|a|patch|pl|p|dev)((?:[.-]?\d+)*)$/;

/** Parse a version (normalized or as written: `v1.2`, `1.2.3-beta.1`, `dev-main`, `1.0.x-dev`); undefined when it is none. */
export function parseVersion(text: string): Version | undefined {
  const version = text.trim().replace(/^v(?=\d)/i, '');
  if (/^dev-/i.test(version)) return { parts: [], stability: 'dev', pre: 0, branch: version.toLowerCase() };
  const match = /^(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(.*)$/i.exec(version);
  if (!match) return undefined;
  const parts = [match[1], match[2], match[3], match[4]].map((part) => (part === undefined ? 0 : /[x*]/i.test(part) ? 9999999 : Number(part)));
  const rest = match[5] ?? '';
  if (!rest) return { parts, stability: 'stable', pre: 0 };
  const suffix = STABILITY_SUFFIX.exec(rest.replace(/^-?(?=[a-z])/i, '-')) ?? STABILITY_SUFFIX.exec(rest);
  if (!suffix) return undefined;
  const name = suffix[1]!.toLowerCase();
  const stability: Stability = name === 'dev' ? 'dev' : name === 'rc' ? 'RC' : name.startsWith('b') ? 'beta' : name.startsWith('a') ? 'alpha' : 'stable';
  // `1.0.x-dev` is a dev version too.
  return { parts, stability: /-dev$/i.test(rest) ? 'dev' : stability, pre: Number((suffix[2] ?? '').replace(/\D/g, '') || 0) };
}

/** Negative, zero or positive, as `a` sorts before, with or after `b`; branches sort below every numbered version. */
export function compareVersions(a: Version, b: Version): number {
  if (a.branch || b.branch) return a.branch && b.branch ? a.branch.localeCompare(b.branch) : a.branch ? -1 : 1;
  for (let i = 0; i < 4; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i]! - b.parts[i]!;
  return RANK[a.stability] - RANK[b.stability] || a.pre - b.pre;
}

export const stabilityAtLeast = (version: Version, minimum: Stability) => RANK[version.stability] >= RANK[minimum];

export function parseStability(text: string | undefined): Stability {
  const name = (text ?? 'stable').toLowerCase();
  return name === 'rc' ? 'RC' : (['dev', 'alpha', 'beta', 'stable'] as const).find((value) => value === name) ?? 'stable';
}

type Test = (version: Version) => boolean;

export interface Constraint {
  test: Test;
  /** The lowest stability the constraint itself admits (`@dev`, `dev-main`, `1.0-beta`), if it lowers it. */
  stability?: Stability;
}

const at = (parts: number[], stability: Stability = 'dev'): Version => ({ parts: [...parts, 0, 0, 0, 0].slice(0, 4), stability, pre: 0 });
const ge = (bound: Version): Test => (v) => !v.branch && compareVersions(v, bound) >= 0;
const lt = (bound: Version): Test => (v) => !v.branch && compareVersions(v, bound) < 0;
const both = (a: Test, b: Test): Test => (v) => a(v) && b(v);

/** The numeric parts a constraint atom wrote (`1.2` → [1, 2]). */
const written = (text: string) => text.replace(/^v/i, '').split(/[-@+]/)[0]!.split('.').filter((part) => /^\d+$/.test(part)).map(Number);

function atom(text: string): Constraint | undefined {
  const flag = /@(stable|rc|beta|alpha|dev)$/i.exec(text);
  const body = flag ? text.slice(0, flag.index) : text;
  const stability = flag ? parseStability(flag[1]) : undefined;
  const withFlag = (test: Test, own?: Stability): Constraint => ({ test, stability: stability ?? own });
  if (body === '' || body === '*' || /^[*x](\.[*x])*$/i.test(body)) return withFlag(() => true);
  if (/^dev-/i.test(body)) {
    const branch = body.toLowerCase();
    return withFlag((v) => v.branch === branch, 'dev');
  }
  const op = /^(\^|~|>=|<=|>|<|!=|==|=)?\s*(.+)$/.exec(body);
  if (!op) return undefined;
  const [, operator = '', rest = ''] = op;
  const version = parseVersion(rest);
  if (!version) return undefined;
  const own = version.stability === 'stable' ? undefined : version.stability;
  const parts = written(rest);
  if (/[*x]$/i.test(rest.replace(/-dev$/i, '')) && operator === '' && !/-dev$/i.test(rest)) {
    // 1.2.* → >=1.2.0.0-dev <1.3.0.0-dev
    const fixed = parts;
    const upper = [...fixed.slice(0, -1), (fixed[fixed.length - 1] ?? -1) + 1];
    return withFlag(fixed.length ? both(ge(at(fixed)), lt(at(upper))) : () => true);
  }
  switch (operator) {
    case '^': {
      const significant = parts.findIndex((part) => part !== 0);
      const index = significant === -1 ? Math.max(parts.length - 1, 0) : significant;
      const upper = [...parts.slice(0, index), (parts[index] ?? 0) + 1];
      return withFlag(both(ge(at(parts, version.stability === 'stable' ? 'dev' : version.stability)), lt(at(upper))), own);
    }
    case '~': {
      const index = Math.max(parts.length - 2, 0);
      const upper = [...parts.slice(0, index), (parts[index] ?? 0) + 1];
      return withFlag(both(ge(at(parts, version.stability === 'stable' ? 'dev' : version.stability)), lt(at(upper))), own);
    }
    case '>=':
      return withFlag(ge(version.stability === 'stable' ? at(parts) : version), own);
    case '>':
      return withFlag((v) => !v.branch && compareVersions(v, version) > 0, own);
    case '<':
      return withFlag(lt(version.stability === 'stable' ? at(parts) : version), own);
    case '<=':
      return withFlag((v) => !v.branch && compareVersions(v, version) <= 0, own);
    case '!=':
      return withFlag((v) => v.branch !== undefined || compareVersions(v, version) !== 0, own);
    default:
      // Exact: `1.0.0`, `==1.0`, `1.0.x-dev`.
      return withFlag((v) => !v.branch && compareVersions(v, version) === 0, own);
  }
}

const lowest = (values: Array<Stability | undefined>): Stability | undefined =>
  values.reduce<Stability | undefined>((low, value) => (value && (!low || RANK[value] < RANK[low]) ? value : low), undefined);

/** Parse a constraint string; undefined when it cannot be read. */
export function parseConstraint(text: string): Constraint | undefined {
  const alternatives = text.trim().split(/\s*\|\|?\s*/);
  const parsed: Constraint[] = [];
  for (const alternative of alternatives) {
    // `>= 1.0` → `>=1.0`; a hyphen range `1.0 - 2.0` is one conjunction.
    const tidy = alternative.replace(/(\^|~|>=|<=|>|<|!=|==|=)\s+/g, '$1').trim();
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(tidy);
    if (hyphen) {
      const low = parseVersion(hyphen[1]!);
      const highParts = written(hyphen[2]!);
      if (!low) return undefined;
      // `1.0 - 2.0` is <2.1 (a partial upper bound), `1.0 - 2.0.0` is <=2.0.0.
      const upper: Test = highParts.length < 3 ? lt(at([...highParts.slice(0, -1), highParts[highParts.length - 1]! + 1])) : (v) => !v.branch && compareVersions(v, at(highParts, 'stable')) <= 0;
      parsed.push({ test: both(ge(at(written(hyphen[1]!))), upper) });
      continue;
    }
    const atoms = tidy.split(/\s*,\s*|\s+/).filter(Boolean).map(atom);
    if (!atoms.length || atoms.some((entry) => !entry)) return undefined;
    const conjunction = atoms as Constraint[];
    parsed.push({ test: (v) => conjunction.every((entry) => entry.test(v)), stability: lowest(conjunction.map((entry) => entry.stability)) });
  }
  return { test: (v) => parsed.some((entry) => entry.test(v)), stability: lowest(parsed.map((entry) => entry.stability)) };
}

/** Whether `version` (as written or normalized) satisfies `constraint`. */
export function satisfies(version: string, constraint: string): boolean {
  const parsedVersion = parseVersion(version);
  const parsedConstraint = parseConstraint(constraint);
  return !!parsedVersion && !!parsedConstraint && parsedConstraint.test(parsedVersion);
}
