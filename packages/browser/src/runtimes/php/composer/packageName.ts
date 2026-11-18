/**
 * Composer package names, validated where they enter the installer — the root
 * composer.json, composer.lock, installed.json, `composer require` arguments,
 * and the `require` keys of repository metadata — so a name can never climb
 * out of `vendor/` or reshape a URL. The patterns are Composer's own: package
 * names (`vendor/package`, lower-case, `[_.-]` separators) and platform names
 * (`php`, `ext-…`, `lib-…`, `composer-…-api`: exact, never a prefix). As
 * defence in depth, every vendor path and URL built from a name refuses `.`
 * and `..` segments again.
 */
import { join } from '@seanhogg/builderforce-webcontainers-core';
import { isPlatformPackage } from './platform.js';

/** Composer's `PACKAGE_NAME_PATTERN` (composer/composer src/Composer/Package/Loader/ValidatingArrayLoader.php). */
const NAME = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]?|-{0,2})[a-z0-9]+)*$/;

export class InvalidPackageName extends Error {}

/** Whether `name` is a valid Composer package name (`vendor/package`). */
export const validPackageName = (name: string) => NAME.test(name) && !hasDotSegment(name);

const hasDotSegment = (path: string) => path.split('/').some((segment) => segment === '.' || segment === '..' || segment === '');

const invalid = (name: string, where: string) =>
  new InvalidPackageName(`Invalid package name "${name}" in ${where}: Composer names are vendor/package, lower-case letters, digits and [_.-] separators.`);

/** `name`, lower-cased — a package or a platform name — or an error naming where the invalid name came from. */
export function checkPackageName(name: string, where: string): string {
  const lower = name.toLowerCase();
  if (isPlatformPackage(lower) || validPackageName(lower)) return lower;
  throw invalid(name, where);
}

/** `name`, lower-cased, when it is an installable package (never a platform name): what may become a directory under vendor/. */
export function checkInstallableName(name: unknown, where: string): string {
  const lower = typeof name === 'string' ? name.toLowerCase() : '';
  if (validPackageName(lower)) return lower;
  throw invalid(String(name), where);
}

/** `<projectDir>/vendor/<name>`, refused for anything but an installable package name. */
export function vendorPath(projectDir: string, name: string): string {
  return join(projectDir, 'vendor', checkInstallableName(name, 'a vendor path'));
}

/** `vendor/package` with each segment URL-encoded, for a `{name}` URL template; `.`/`..` segments are refused. */
export function encodePackageName(name: string): string {
  if (hasDotSegment(name)) throw invalid(name, 'a repository URL');
  return name.split('/').map(encodeURIComponent).join('/');
}
