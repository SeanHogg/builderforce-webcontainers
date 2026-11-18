/**
 * The PHP runtime's process-kind policy for the process host
 * (node/processKinds.ts): PHP commands (`php`, `composer`) — and scripts whose
 * shebang names PHP (`./artisan`, `#!/usr/bin/env php`) — run in a PHP process
 * Worker, whose start message carries the host's instructions (where php-wasm
 * is served, the PHP version, Composer's sources). Every other command goes to
 * `next` (the Python policy, or Node only), so one host chains the runtimes:
 * `createPhpProcessKind(options.php, createPythonProcessKind(options.python))`.
 *
 * A PHP process reports the running PHP's version and extensions
 * (`php-platform`); the policy keeps the latest well-formed report from a PHP
 * process ({@link PhpProcessKind.platform}), which `createPhpProvider` checks
 * services against.
 */
import { NODE_ONLY, unionCommandPatterns, type ProcessKindPolicy, type ProcessRoute } from '../../node/processKinds.js';
import { shebangRoute } from '../shebangRoute.js';
import type { Platform } from './composer/platform.js';
import { PHP_COMMAND_PATTERN, isPhpCommand } from './phpCommand.js';
import { PHP_KIND, type PhpStartOptions } from './phpStartOptions.js';

export { PHP_KIND };

/** Host-only settings for PHP processes: a program's environment can change none of them. */
export type PhpHostOptions = PhpStartOptions;

/** The running PHP as PHP processes last reported it. */
export interface PhpPlatformRecord {
  current(): Platform | undefined;
}

export interface PhpProcessKind extends ProcessKindPolicy {
  readonly platform: PhpPlatformRecord;
}

/** A well-formed `php-platform` report, or undefined. */
function platformReport(message: unknown): Platform | undefined {
  const report = message as { phpVersion?: unknown; extensions?: unknown };
  if (typeof report.phpVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(report.phpVersion) || !Array.isArray(report.extensions) || report.extensions.length > 500) return undefined;
  if (!report.extensions.every((name) => typeof name === 'string' && name.length < 64)) return undefined;
  return { phpVersion: report.phpVersion, extensions: new Set((report.extensions as string[]).map((name) => name.toLowerCase())) };
}

export function createPhpProcessKind(options: PhpHostOptions = {}, next: ProcessKindPolicy = NODE_ONLY): PhpProcessKind {
  let platform: Platform | undefined;
  return {
    platform: { current: () => platform },
    foreignCommands: unionCommandPatterns(PHP_COMMAND_PATTERN, next.foreignCommands),
    route(command, args, context): ProcessRoute {
      if (isPhpCommand(command)) return { kind: PHP_KIND, command, args };
      // A script run by path: its shebang may name PHP (`#!/usr/bin/env php`).
      const script = shebangRoute(command, args, context, isPhpCommand);
      return script ? { kind: PHP_KIND, ...script } : next.route(command, args, context);
    },
    startOptions: (kind) => (kind === PHP_KIND ? { php: { ...options } } : next.startOptions(kind)),
    receive(kind, message) {
      if ((message as { type?: unknown })?.type !== 'php-platform') return next.receive(kind, message);
      // Only a PHP process speaks for PHP; anything malformed is dropped.
      const report = kind === PHP_KIND ? platformReport(message) : undefined;
      if (report) platform = report;
      return true;
    },
  };
}
