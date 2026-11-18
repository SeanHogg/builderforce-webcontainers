/**
 * Composer's platform packages, checked against the running PHP: `php` (its
 * version), `php-64bit` (php-wasm is 32-bit), `ext-<name>` (the extensions the
 * php-wasm image has loaded), `lib-*` (libraries behind extensions; assumed
 * present when their extension is), and `composer`, `composer-plugin-api`,
 * `composer-runtime-api` (the runtime's installer stands in for Composer 2).
 * A package that needs what the image lacks is declined by name, with the
 * reason — so it can go to the container target.
 */
import { satisfies } from './semver.js';

export interface Platform {
  /** PHP_VERSION. */
  phpVersion: string;
  /** Loaded extensions, lower-case (`get_loaded_extensions()`). */
  extensions: ReadonlySet<string>;
}

/** The Composer API versions the runtime's installer answers as. */
const COMPOSER_APIS: Record<string, string> = { composer: '2.8.0', 'composer-plugin-api': '2.6.0', 'composer-runtime-api': '2.2.2' };

export const isPlatformPackage = (name: string) => name === 'php' || name.startsWith('php-') || name.startsWith('ext-') || name.startsWith('lib-') || name in COMPOSER_APIS;

/** Why the image has no Postgres extension, and what to use instead. */
export const PGSQL_REASON = "php-wasm's images have no pgsql/pdo_pgsql extension (and no libpq to build one); use \\Bfwc\\Pgsql\\PDO (a PDO subclass over the runtime's wire client) for Postgres";

/** Extension names Composer uses that differ from `get_loaded_extensions()`'s. */
const EXTENSION_ALIASES: Record<string, string> = { 'zend-opcache': 'zend opcache', opcache: 'zend opcache' };

/** Why `name` at `constraint` is not met here, or undefined when it is. */
export function platformShortfall(name: string, constraint: string, platform: Platform): string | undefined {
  const lower = name.toLowerCase();
  if (lower === 'php' || lower === 'php-zts' || lower === 'php-debug') {
    if (lower !== 'php') return `${name} is not available (php-wasm is a non-thread-safe release build).`;
    return satisfies(platform.phpVersion, constraint) ? undefined : `PHP ${platform.phpVersion} does not satisfy php ${constraint}.`;
  }
  if (lower === 'php-64bit') return 'php-64bit is not available (php-wasm is 32-bit).';
  if (lower === 'php-ipv6') return undefined;
  if (lower in COMPOSER_APIS) return satisfies(COMPOSER_APIS[lower]!, constraint) ? undefined : `${name} ${constraint} is not provided (the runtime's installer answers as ${name} ${COMPOSER_APIS[lower]}).`;
  if (lower.startsWith('ext-')) {
    const extension = lower.slice(4);
    if (platform.extensions.has(EXTENSION_ALIASES[extension] ?? extension)) return undefined;
    if (extension === 'pgsql' || extension === 'pdo_pgsql') return `ext-${extension}: ${PGSQL_REASON}.`;
    return `ext-${extension} is not in the php-wasm image (loaded: ${[...platform.extensions].sort().join(', ')}).`;
  }
  return undefined; // lib-*: present with their extension
}
