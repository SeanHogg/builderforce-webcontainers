/**
 * Package specifiers as `npm install` and package.json write them:
 * `react`, `react@^18`, `@scope/pkg@latest`, and aliases (`foo@npm:bar@^1`).
 * Git, file and URL specs are recognised so they can be declined with a reason.
 */

export interface ParsedSpec {
  /** The name it is installed under (the alias, for `npm:` specs). */
  name: string;
  /** The registry package actually fetched. */
  registryName: string;
  /** A semver range or a dist-tag. `''` when none was given. */
  range: string;
}

const UNSUPPORTED = /^(?:git\+|git:|github:|gitlab:|bitbucket:|file:|link:|https?:|workspace:)/;

/** Split `name@range` (the CLI form). */
export function parseInstallSpec(spec: string): ParsedSpec {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const name = at < 0 ? spec : spec.slice(0, at);
  const range = at < 0 ? '' : spec.slice(at + 1);
  return parseDependency(name, range);
}

/** A package.json `dependencies` entry: `"foo": "npm:bar@^1"` or `"foo": "^1"`. */
export function parseDependency(name: string, range: string): ParsedSpec {
  if (!name || /\s/.test(name)) throw new Error(`Invalid package name "${name}".`);
  if (range.startsWith('npm:')) {
    const inner = parseInstallSpec(range.slice(4));
    return { name, registryName: inner.registryName, range: inner.range };
  }
  if (UNSUPPORTED.test(range) || /^[^@/\s]+\/[^@/\s]+(#.*)?$/.test(range)) {
    throw new Error(`"${name}@${range}": only registry packages are supported (not git, file or URL dependencies).`);
  }
  return { name, registryName: name, range: range.trim() };
}

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  [key: string]: unknown;
}

export function sortObject(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
