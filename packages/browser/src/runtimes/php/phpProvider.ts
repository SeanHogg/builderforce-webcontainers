/**
 * The `php` runtime provider for `startApplicationRuntime`: a service whose
 * command is PHP (`php -S 0.0.0.0:8000 -t public`, `php worker.php`,
 * `composer install`) runs as a PHP process of the runtime — the process host
 * gives PHP commands a PHP Worker — and is held to the same readiness as a
 * Node service (its port opening, a health URL, a clean exit): the Node
 * provider's start is reused as is. What it cannot run it declines with a
 * reason: non-PHP commands, command lines the runtime refuses, and — given the
 * project's files — composer.json requirements the running PHP cannot meet
 * (`php` versions, `ext-pgsql`, `ext-redis` …), each named, so the host can
 * send the application to the container target.
 *
 * The PHP checked against is the one PHP processes reported
 * (`createPhpProcessKind(…).platform`); before any has run, the pinned
 * php-wasm release of the host's `php.phpVersion` (the same options object the
 * host gets) and the extensions its images load.
 */
import { readinessOf, type Acceptance, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { join, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { createNodeProvider, type NodeProviderOptions } from '../../app/nodeProvider.js';
import type { NodeServiceHost } from '../../app/nodeReadiness.js';
import { platformShortfall, type Platform } from './composer/platform.js';
import { isPhpCommand, parsePhpCommand } from './phpCommand.js';
import { PHP_WASM_RELEASES, checkPhpVersion } from './phpLoader.js';
import type { PhpHostOptions, PhpPlatformRecord } from './phpProcessKind.js';

/** Extensions php-wasm 3.1.62's images load (PHP 8.1–8.4): the fallback until a PHP process reports its own. */
export const PHP_WASM_EXTENSIONS: readonly string[] = [
  'core', 'date', 'libxml', 'openssl', 'pcre', 'sqlite3', 'zlib', 'bcmath', 'calendar', 'ctype', 'curl', 'dom', 'hash', 'fileinfo', 'filter', 'gd', 'json', 'iconv',
  'spl', 'session', 'mbstring', 'standard', 'mysqlnd', 'exif', 'mysqli', 'pdo', 'pdo_mysql', 'pdo_sqlite', 'phar', 'random', 'reflection', 'simplexml', 'soap',
  'tokenizer', 'xml', 'xmlreader', 'xmlwriter', 'zip', 'zend opcache',
];

export interface PhpProviderOptions extends NodeProviderOptions {
  /** The project's files: with them, a service whose composer.json needs what the running PHP lacks is declined up front, by name. */
  fs?: VirtualFileSystem;
  /** The host's PHP options (the object given to the host): its `phpVersion` is what services run. */
  php?: PhpHostOptions;
  /** What PHP processes reported (`createPhpProcessKind(…).platform`). */
  platform?: PhpPlatformRecord;
}

/** The PHP a service runs on: as reported, else the pinned release of `phpVersion` with the images' extensions. */
export function expectedPlatform(options: Pick<PhpProviderOptions, 'php' | 'platform'> = {}): Platform {
  return options.platform?.current() ?? { phpVersion: PHP_WASM_RELEASES[checkPhpVersion(options.php?.phpVersion)]!, extensions: new Set(PHP_WASM_EXTENSIONS) };
}

export function acceptsPhpService(service: ServiceSpec, fs?: VirtualFileSystem, platform: Platform = expectedPlatform()): Acceptance {
  if (service.type !== 'application') return { ok: false, reason: `The php runtime runs application services; "${service.id}" is a ${service.type} service.` };
  if (readinessOf(service).kind === 'query') return { ok: false, reason: `"query" readiness is for databases; service "${service.id}" runs on php.` };
  const command = service.command;
  if (!command || !isPhpCommand(command)) return { ok: false, reason: `Service "${service.id}": "${command ?? ''}" is not a PHP command (php, composer).` };
  const parsed = parsePhpCommand(command, service.args ?? []);
  if (!parsed.ok) return { ok: false, reason: `Service "${service.id}": ${parsed.reason}` };
  const text = fs?.readText(join(service.root ?? '/', 'composer.json'));
  if (text !== undefined) {
    let composer: { require?: Record<string, string> };
    try {
      composer = JSON.parse(text) as typeof composer;
    } catch (error) {
      return { ok: false, reason: `Service "${service.id}": composer.json is not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
    }
    const shortfalls = Object.entries(composer.require ?? {}).flatMap(([name, constraint]) => {
      if (!name.startsWith('ext-') && !name.startsWith('php')) return [];
      const shortfall = platformShortfall(name, constraint, platform);
      return shortfall ? [shortfall] : [];
    });
    if (shortfalls.length) return { ok: false, reason: `Service "${service.id}" needs what the php-wasm image lacks: ${shortfalls.join(' ')}` };
  }
  return { ok: true };
}

/** `host` is the runtime (`startPreviewRuntime()`'s, or a `ProcessHost` adapted): it runs PHP commands in PHP Workers. */
export function createPhpProvider(host: NodeServiceHost, options: PhpProviderOptions = {}): RuntimeProvider {
  const { start } = createNodeProvider(host, options);
  return {
    id: 'php',
    accepts: (service) => {
      try {
        return acceptsPhpService(service, options.fs, expectedPlatform(options));
      } catch (error) {
        return { ok: false, reason: `Service "${service.id}": ${error instanceof Error ? error.message : String(error)}` };
      }
    },
    start,
  };
}
