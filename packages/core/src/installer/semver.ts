/**
 * The slice of node-semver an installer needs: parse, compare, range matching
 * and "highest version satisfying". Written here rather than depending on the
 * `semver` package because that one is CommonJS, and the core must load as
 * native ESM in a browser without a bundler step.
 *
 * Semantics follow node-semver (and so npm): `^`/`~`/x-ranges/hyphen ranges,
 * `||` unions, and the prerelease rule — a prerelease only satisfies a range
 * that names a prerelease on the same major.minor.patch.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
  /** Normalised `1.2.3-beta.1` (build metadata dropped). */
  version: string;
}

type Op = '<' | '<=' | '>' | '>=' | '=';
interface Comparator {
  op: Op;
  version: SemVer;
}
/** OR of AND sets; an empty AND set matches every (non-prerelease) version. */
type Range = Comparator[][];

const VERSION = /^\s*[v=]*\s*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?\s*$/;
const PARTIAL = /^[v=]*(\d+|[xX*])?(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-.]+)?$/;

export function parseVersion(input: string): SemVer | null {
  const m = VERSION.exec(input);
  if (!m) return null;
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return make(Number(m[1]), Number(m[2]), Number(m[3]), prerelease);
}

function make(major: number, minor: number, patch: number, prerelease: Array<string | number> = []): SemVer {
  const pre = prerelease.length ? `-${prerelease.join('.')}` : '';
  return { major, minor, patch, prerelease, version: `${major}.${minor}.${patch}${pre}` };
}

export function valid(input: string): string | null {
  return parseVersion(input)?.version ?? null;
}

function comparePre(a: SemVer, b: SemVer): number {
  if (!a.prerelease.length || !b.prerelease.length) return (b.prerelease.length ? 1 : 0) - (a.prerelease.length ? 1 : 0) || 0;
  for (let i = 0; ; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined && y === undefined) return 0;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1; // numeric identifiers sort below alphanumeric ones
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
}

/** -1, 0 or 1. Accepts strings or parsed versions. */
export function compare(a: string | SemVer, b: string | SemVer): number {
  const x = typeof a === 'string' ? parseVersion(a) : a;
  const y = typeof b === 'string' ? parseVersion(b) : b;
  if (!x || !y) throw new TypeError(`Invalid version: ${!x ? String(a) : String(b)}`);
  return Math.sign(x.major - y.major || x.minor - y.minor || x.patch - y.patch) || comparePre(x, y);
}

const isX = (part: string | undefined) => part === undefined || part === 'x' || part === 'X' || part === '*';

/** One `op + partial` token → comparators (an x-range expands to a pair). */
function expand(token: string): Comparator[] | null {
  const opMatch = /^(~>?|\^|<=|>=|<|>|=)?(.*)$/.exec(token)!;
  const op = opMatch[1] ?? '';
  const m = PARTIAL.exec(opMatch[2]!);
  if (!m) return null;
  const [, M, m2, p, pre] = m;
  const pr = pre ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  const xM = isX(M), xm = xM || isX(m2), xp = xm || isX(p);
  const maj = xM ? 0 : Number(M), min = xm ? 0 : Number(m2), pat = xp ? 0 : Number(p);
  const ge = (v: SemVer): Comparator => ({ op: '>=', version: v });
  const lt = (v: SemVer): Comparator => ({ op: '<', version: v });
  const upper = (a: number, b: number, c: number) => lt(make(a, b, c, [0]));

  if (op === '^') {
    if (xM) return [];
    const lower = ge(make(maj, min, pat, pr));
    if (maj > 0 || xm) return [lower, upper(maj + 1, 0, 0)];
    if (min > 0 || xp) return [lower, upper(0, min + 1, 0)];
    return [lower, upper(0, 0, pat + 1)];
  }
  if (op === '~' || op === '~>') {
    if (xM) return [];
    const lower = ge(make(maj, min, pat, pr));
    return xm ? [lower, upper(maj + 1, 0, 0)] : [lower, upper(maj, min + 1, 0)];
  }
  if (op === '' || op === '=') {
    if (xM) return [];
    if (xm) return [ge(make(maj, 0, 0)), upper(maj + 1, 0, 0)];
    if (xp) return [ge(make(maj, min, 0)), upper(maj, min + 1, 0)];
    return [{ op: '=', version: make(maj, min, pat, pr) }];
  }
  // <, <=, >, >= with a partial version.
  if (xM) return op === '<' || op === '>' ? [lt(make(0, 0, 0, [0]))] : [];
  if (!xp) return [{ op: op as Op, version: make(maj, min, pat, pr) }];
  if (op === '>') return [ge(xm ? make(maj + 1, 0, 0) : make(maj, min + 1, 0))];
  if (op === '<=') return [xm ? upper(maj + 1, 0, 0) : upper(maj, min + 1, 0)];
  if (op === '<') return [lt(make(maj, min, 0, [0]))];
  return [ge(make(maj, min, 0))]; // >=
}

function parsePartialBound(text: string): { parts: string[]; full: SemVer | null } {
  return { parts: text.replace(/^[v=]+/, '').split('-')[0]!.split('.'), full: parseVersion(text) };
}

function hyphen(from: string, to: string): Comparator[] | null {
  const lower = expand(`>=${from}`);
  if (!lower) return null;
  const { parts, full } = parsePartialBound(to);
  if (full) return [...lower, { op: '<=', version: full }];
  if (isX(parts[0])) return lower;
  const upperC = expand(`<=${to}`);
  return upperC ? [...lower, ...upperC] : null;
}

const cache = new Map<string, Range | null>();

export function parseRange(input: string): Range | null {
  const hit = cache.get(input);
  if (hit !== undefined) return hit;
  let range: Range | null = [];
  for (const raw of input.split('||')) {
    const part = raw.trim().replace(/(<=|>=|<|>|=|~>?|\^)\s+/g, '$1');
    const h = /^(\S+)\s+-\s+(\S+)$/.exec(part);
    const set = h ? hyphen(h[1]!, h[2]!) : part.split(/\s+/).filter(Boolean).reduce<Comparator[] | null>((acc, token) => {
      const c = acc && expand(token);
      return c ? [...acc!, ...c] : null;
    }, []);
    if (!set) {
      range = null;
      break;
    }
    range.push(set);
  }
  cache.set(input, range);
  return range;
}

export function validRange(input: string): boolean {
  return parseRange(input) !== null;
}

function test(c: Comparator, v: SemVer): boolean {
  const d = compare(v, c.version);
  switch (c.op) {
    case '<': return d < 0;
    case '<=': return d <= 0;
    case '>': return d > 0;
    case '>=': return d >= 0;
    default: return d === 0;
  }
}

function testSet(set: Comparator[], v: SemVer, includePrerelease: boolean): boolean {
  if (!set.every((c) => test(c, v))) return false;
  if (!v.prerelease.length || includePrerelease) return true;
  // A prerelease only matches when the range itself names one on the same tuple.
  return set.some((c) => c.version.prerelease.length > 0
    && c.version.major === v.major && c.version.minor === v.minor && c.version.patch === v.patch);
}

export function satisfies(version: string | SemVer, range: string, options: { includePrerelease?: boolean } = {}): boolean {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const r = parseRange(range);
  if (!v || !r) return false;
  return r.some((set) => testSet(set, v, options.includePrerelease ?? false));
}

/** The highest of `versions` satisfying `range`, or null. */
export function maxSatisfying(versions: Iterable<string>, range: string): string | null {
  let best: SemVer | null = null;
  for (const raw of versions) {
    const v = parseVersion(raw);
    if (v && satisfies(v, range) && (!best || compare(v, best) > 0)) best = v;
  }
  return best?.version ?? null;
}
