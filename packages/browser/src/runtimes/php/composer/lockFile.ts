/**
 * composer.json and composer.lock as the PHP runtime's installer reads and
 * writes them: the root package's shape, what it is allowed to use
 * (repositories), the lock's layout (runtime `packages` vs `packages-dev`,
 * decided by reachability from the root's `require`), and the root's
 * requirement arguments (`composer require vendor/pkg ^1.0`).
 */
import type { RootPackage } from './autoload.js';
import { checkPackageName } from './packageName.js';
import type { PackageVersion } from './packagist.js';
import type { RootLinks } from './resolve.js';

export interface ComposerJson extends RootPackage, RootLinks {
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  'minimum-stability'?: string;
  'prefer-stable'?: boolean;
  scripts?: Record<string, unknown>;
  repositories?: unknown;
}

export interface LockFile {
  'content-hash'?: string;
  packages?: PackageVersion[];
  'packages-dev'?: PackageVersion[];
}

/** Why composer.json's `repositories` cannot be honoured here, or undefined when they can (none, or Packagist itself). */
export function unsupportedRepositories(composer: ComposerJson): string | undefined {
  const entries = Array.isArray(composer.repositories) ? composer.repositories : Object.entries((composer.repositories ?? {}) as Record<string, unknown>).map(([key, value]) => (value === false ? { type: `${key}: false` } : value));
  const unsupported = entries
    .map((entry) => entry as { type?: unknown; url?: unknown } | null)
    .filter((entry) => !(entry?.type === 'composer' && typeof entry.url === 'string' && /^https:\/\/(repo\.)?packagist\.org\/?$/.test(entry.url)))
    .map((entry) => (typeof entry?.type === 'string' ? entry.type : 'unknown'));
  if (!unsupported.length) return undefined;
  return `composer.json declares repositories of type ${[...new Set(unsupported)].join(', ')}, which the PHP runtime does not support (it installs from Packagist, or the host's php.composer.repositoryUrl, only).`;
}

/** `composer require` arguments as name → constraint (undefined: pick one): `a/b:^1`, `a/b=^1`, `a/b ^1`. */
export function requireArguments(args: readonly string[]): Array<{ name: string; constraint?: string }> {
  const out: Array<{ name: string; constraint?: string }> = [];
  for (const arg of args) {
    const split = /^([^:=\s]+)[:=](.+)$/.exec(arg);
    if (split) out.push({ name: checkPackageName(split[1]!, 'composer require'), constraint: split[2] });
    else if (!arg.includes('/') && out.length && out[out.length - 1]!.constraint === undefined) out[out.length - 1]!.constraint = arg;
    else out.push({ name: checkPackageName(arg, 'composer require') });
  }
  return out;
}

/** The chosen packages the root's `require` reaches (through `require`, `replace` and `provide`): the lock's `packages`; the rest are `packages-dev`. */
export function runtimePackages(composer: ComposerJson, chosen: ReadonlyMap<string, PackageVersion>): Set<string> {
  const standIns = new Map<string, string>();
  for (const pkg of chosen.values()) for (const name of [...Object.keys(pkg.replace ?? {}), ...Object.keys(pkg.provide ?? {})]) standIns.set(name.toLowerCase(), pkg.name);
  const reached = new Set<string>();
  const queue = Object.keys(composer.require ?? {}).map((name) => name.toLowerCase());
  while (queue.length) {
    const name = queue.shift()!;
    const pkg = chosen.get(name) ?? chosen.get(standIns.get(name) ?? '');
    if (!pkg || reached.has(pkg.name)) continue;
    reached.add(pkg.name);
    queue.push(...Object.keys(pkg.require ?? {}).map((dep) => dep.toLowerCase()));
  }
  return reached;
}

/** The lock file's text. */
export function lockText(lock: LockFile, options: { minimumStability: string; preferStable: boolean }): string {
  return `${JSON.stringify(
    {
      _readme: ['This file locks the dependencies of your project to a known state', 'Written by the BuilderForce WebContainers PHP runtime'],
      ...lock,
      aliases: [],
      'minimum-stability': options.minimumStability,
      'stability-flags': {},
      'prefer-stable': options.preferStable,
      'prefer-lowest': false,
      platform: {},
      'platform-dev': {},
      'plugin-api-version': '2.6.0',
    },
    null,
    4,
  )}\n`;
}
