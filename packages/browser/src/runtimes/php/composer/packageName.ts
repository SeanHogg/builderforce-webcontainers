/**
 * Composer package names, validated where they enter the installer — the root
 * composer.json, composer.lock, `composer require` arguments, and the
 * `require` keys of repository metadata — so a name can never climb out of
 * `vendor/` or reshape a URL. The pattern is Composer's own
 * (`vendor/package`, lower-case, `[_.-]` separators).
 */
import { isPlatformPackage } from './platform.js';

/** Composer's `PACKAGE_NAME_PATTERN` (composer/composer src/Composer/Package/Loader/ValidatingArrayLoader.php). */
const NAME = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]?|-{0,2})[a-z0-9]+)*$/;

/** Whether `name` is a valid Composer package name (`vendor/package`). */
export const validPackageName = (name: string) => NAME.test(name);

/** `name`, lower-cased, or an error naming where the invalid name came from. */
export function checkPackageName(name: string, where: string): string {
  const lower = name.toLowerCase();
  if (isPlatformPackage(lower) || validPackageName(lower)) return lower;
  throw new InvalidPackageName(`Invalid package name "${name}" in ${where}: Composer names are vendor/package, lower-case letters, digits and [_.-] separators.`);
}

export class InvalidPackageName extends Error {}

/** `vendor/package` with each segment URL-encoded, for a `{name}` URL template. */
export const encodePackageName = (name: string) => name.split('/').map(encodeURIComponent).join('/');
