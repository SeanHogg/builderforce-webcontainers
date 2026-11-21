/**
 * What a PHP command line asks for, as the PHP runtime runs it: PHP's own CLI
 * (a script, `-r` code, `-v`, `-m` …: php-wasm runs PHP's real CLI on the
 * arguments), the built-in web server (`php -S host:port [-t docroot]
 * [router.php]`) served request-driven, or Composer (`composer install`,
 * `php composer.phar install`). Pure: no php-wasm, no file system (a `.env`
 * is read through the caller's `readText`).
 */
import { normalizePath, parseDotenv } from '@seanhogg/builderforce-webcontainers-core';

export interface PhpServerSpec {
  host: string;
  port: number;
  /** `-t`: the document root (relative to the cwd). Default: the cwd. */
  docroot?: string;
  /** The router script, run for every request (it may `return false` to have the file served as is). */
  router?: string;
  /**
   * A router used only when the file exists (else the built-in routing):
   * Laravel's own `server.php` for `php artisan serve`, which a Laravel-style
   * app without the framework installed does not have.
   */
  routerIfPresent?: string;
  /** `-d name=value` settings, applied to every request. */
  ini: Record<string, string>;
}

export type ComposerCommand = 'install' | 'update' | 'require' | 'dump-autoload';

export interface ComposerRequest {
  command: ComposerCommand;
  /** `require`'s `vendor/name[:constraint]` arguments. */
  packages: string[];
  /** `--no-dev`. */
  noDev: boolean;
  /** `--ignore-platform-reqs`: install packages whose `php`/`ext-*` requirements are not met. */
  ignorePlatformReqs: boolean;
  /** `-d`/`--working-dir`. */
  workingDir?: string;
  /** `--dev` (for `require`): add to `require-dev`. */
  dev: boolean;
}

export type PhpInvocation =
  /** `argv` is PHP's command line after `php` (`['script.php', 'x']`, `['-r', 'echo 1;']`). */
  | { kind: 'cli'; argv: string[] }
  | { kind: 'serve'; server: PhpServerSpec }
  | ({ kind: 'composer' } & ComposerRequest);

export type PhpCommandParse = { ok: true; invocation: PhpInvocation } | { ok: false; reason: string };

const INTERPRETERS = /^php(\d+(\.\d+)?)?(-cli)?(\.exe)?$/;
const COMPOSERS = /^composer(\.phar)?$/;

const basename = (command: string) => command.replace(/\\/g, '/').split('/').pop() ?? command;

/** Every command name the PHP runtime runs, as one RegExp source over a base name — what Node processes hand to the page (`foreignCommands`). */
export const PHP_COMMAND_PATTERN = `^(?:${INTERPRETERS.source.slice(1, -1)}|${COMPOSERS.source.slice(1, -1)})$`;
const PHP_COMMAND = new RegExp(PHP_COMMAND_PATTERN);

/** Whether the PHP runtime (not Node) runs `command`. */
export function isPhpCommand(command: string): boolean {
  return PHP_COMMAND.test(basename(command));
}

const fail = (reason: string): PhpCommandParse => ({ ok: false, reason });
const ok = (invocation: PhpInvocation): PhpCommandParse => ({ ok: true, invocation });

/** CLI options that take the next argument as their value (`-d x=y`, `-c php.ini`, `-z ext`). */
const VALUED = new Set(['-d', '-c', '-z', '-t', '-S', '-f', '-r', '-B', '-R', '-F', '-E', '--rf', '--rc', '--re', '--rz', '--ri']);

/**
 * Where a command line runs, for what it reads beyond its arguments (`php artisan serve`: `SERVER_HOST` and
 * `SERVER_PORT` from the environment, else from the app's `.env`, as Laravel's `Env` does). The provider's
 * acceptance and the PHP Worker's execution both parse with one, so they read the same.
 */
export interface PhpCommandSurroundings {
  /** The process's environment. */
  env?: Readonly<Record<string, string>>;
  /** The working directory (absolute), against which relative paths are read. */
  cwd?: string;
  /** A project file's text by absolute path, or undefined. */
  readText?(path: string): string | undefined;
}

/** The surroundings of a command run in `cwd` with `env` over `files` (the project) — the ONE way both the provider and the Worker build them. */
export function phpSurroundings(env: Readonly<Record<string, string>> | undefined, cwd: string, files: { readText(path: string): string | undefined } | undefined): PhpCommandSurroundings {
  return { env, cwd, readText: (path) => files?.readText(path) };
}

/**
 * Parse `command args…`. `-S` is the built-in server only among PHP's own options (before the script): `php app.php -S x` passes it to the script.
 */
export function parsePhpCommand(command: string, args: readonly string[], surroundings: PhpCommandSurroundings = {}): PhpCommandParse {
  const name = basename(command);
  if (COMPOSERS.test(name)) return parseComposer(args);
  if (!INTERPRETERS.test(name)) return fail(`"${command}" is not a PHP command.`);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-S') return parseServer(args);
    if (arg === '-a') return fail('Interactive PHP (-a) needs a terminal, which the PHP runtime does not provide.');
    if (VALUED.has(arg)) {
      i++;
      continue;
    }
    if (arg === '--') break;
    if (arg.startsWith('-')) continue;
    // The first operand is the script: `php composer.phar install` is Composer.
    if (COMPOSERS.test(basename(arg))) return parseComposer(args.slice(i + 1));
    // `php artisan serve` starts `php -S` through proc_open, which php-wasm has not: it is served here instead.
    if (basename(arg) === 'artisan') {
      const at = artisanCommandAt(args, i + 1);
      if (args[at] === 'serve') return parseArtisanServe(arg, [...args.slice(i + 1, at), ...args.slice(at + 1)], surroundings);
    }
    break;
  }
  if (!args.length) return fail('Interactive PHP (no script or -r code) needs a terminal, which the PHP runtime does not provide.');
  return ok({ kind: 'cli', argv: [...args] });
}

function parseAddress(value: string | undefined): { host: string; port: number } | string {
  if (!value) return 'Option -S needs host:port (php -S localhost:8000).';
  const match = /^(\[[^\]]+\]|[^:]*):(\d+)$/.exec(value);
  const port = Number(match?.[2]);
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) return `Invalid address "${value}": php -S needs host:port (php -S localhost:8000).`;
  return { host: match[1] || 'localhost', port };
}

function parseServer(args: readonly string[]): PhpCommandParse {
  const server: Partial<PhpServerSpec> & { ini: Record<string, string> } = { ini: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-S') {
      const address = parseAddress(args[++i]);
      if (typeof address === 'string') return fail(address);
      Object.assign(server, address);
    } else if (arg === '-t') {
      const docroot = args[++i];
      if (!docroot) return fail('Option -t needs a document root.');
      server.docroot = docroot;
    } else if (arg === '-d') {
      const setting = args[++i] ?? '';
      const eq = setting.indexOf('=');
      server.ini[eq === -1 ? setting : setting.slice(0, eq)] = eq === -1 ? '1' : setting.slice(eq + 1);
    } else if (arg === '-c' || arg === '-z') {
      i++;
    } else if (!arg.startsWith('-')) {
      if (server.router) return fail(`php -S takes one router script; "${arg}" is extra.`);
      server.router = arg;
    } else if (arg !== '-q' && arg !== '-n' && arg !== '-e' && arg !== '-H') {
      return fail(`Option ${arg} is not supported with php -S in the PHP runtime.`);
    }
  }
  return ok({ kind: 'serve', server: server as PhpServerSpec });
}

/** Laravel's router for `php artisan serve`, relative to the app's base directory (where `artisan` is). */
export const LARAVEL_SERVER_ROUTER = 'vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php';

/** Artisan's global options that take the next argument as their value when given without `=`. */
const ARTISAN_VALUED = new Set(['--env']);

/** Where artisan's command name is in `args`, from `from` on: past its global options (`--env=local`, `--env local`, `-q`, `-v`, `--ansi`, `-n` …). */
function artisanCommandAt(args: readonly string[], from: number): number {
  let at = from;
  while (at < args.length && args[at]!.startsWith('-')) {
    if (ARTISAN_VALUED.has(args[at]!) && args[at + 1] !== undefined && !args[at + 1]!.startsWith('-')) at++;
    at++;
  }
  return at;
}

/** Laravel's `getHostAndPort()`: `[::1]:8080` or `host:8080` → host and port; a bare host has none. */
function hostAndPort(value: string): { host: string; port?: string } {
  const bracketed = /^(\[[^\]]*\])(?::(\d*))?$/.exec(value);
  if (bracketed) return bracketed[2] ? { host: bracketed[1]!, port: bracketed[2] } : { host: bracketed[1]! };
  const [host, port] = value.split(':');
  return port ? { host: host!, port } : { host: host! };
}

/**
 * `php artisan serve [--host=…] [--port=…]` as Laravel's ServeCommand runs it:
 * the built-in server on `public/` (beside `artisan`) with Laravel's
 * `server.php` router. `--host` defaults to `SERVER_HOST`, else 127.0.0.1, and
 * may carry a port (`0.0.0.0:8080`, `[::1]:8080`); `--port` defaults to
 * `SERVER_PORT`. The port is `--port` (or `SERVER_PORT`) when given, else the
 * host's, and an empty one is 8000 (`$port ?: 8000`). `SERVER_*` come from the
 * environment, else the app's `.env` (the environment wins, as phpdotenv's
 * immutable loading does). Other options (`--tries`, `--no-reload`, `--env`)
 * change nothing here.
 */
function parseArtisanServe(artisan: string, args: readonly string[], surroundings: PhpCommandSurroundings): PhpCommandParse {
  const normalized = artisan.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const base = slash < 0 ? '' : normalized.slice(0, slash + 1) || '/';
  const dotenvPath = base.startsWith('/') ? `${base}.env` : `${(surroundings.cwd ?? '/').replace(/\/+$/, '')}/${base}.env`;
  const dotenvText = surroundings.readText?.(normalizePath(dotenvPath));
  const env = { ...(dotenvText === undefined ? {} : parseDotenv(dotenvText)), ...surroundings.env };
  let hostOption = env.SERVER_HOST ?? '127.0.0.1';
  let portOption = env.SERVER_PORT;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const [flag, inline] = arg.startsWith('--') && eq !== -1 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (flag !== '--host' && flag !== '--port') continue;
    const value = inline ?? (args[i + 1] !== undefined && !args[i + 1]!.startsWith('-') ? args[++i] : undefined);
    if (value === undefined) continue;
    if (flag === '--host') hostOption = value;
    else portOption = value;
  }
  const { host, port: hostPort } = hostAndPort(hostOption);
  const portText = (portOption ?? hostPort) || undefined;
  const port = portText === undefined ? 8000 : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(`Invalid port "${portText}" for artisan serve.`);
  return ok({ kind: 'serve', server: { host: host || '127.0.0.1', port, docroot: `${base}public`, routerIfPresent: `${base}${LARAVEL_SERVER_ROUTER}`, ini: {} } });
}

/** Composer options with a value, skipped (`--working-dir` is read). */
const COMPOSER_VALUED = new Set(['--prefer-install', '--apcu-autoloader-prefix', '--audit-format', '--ignore-platform-req']);
const COMPOSER_COMMANDS: Record<string, ComposerCommand> = { install: 'install', i: 'install', update: 'update', u: 'update', upgrade: 'update', require: 'require', r: 'require', 'dump-autoload': 'dump-autoload', dumpautoload: 'dump-autoload' };

function parseComposer(args: readonly string[]): PhpCommandParse {
  const request: ComposerRequest = { command: 'install', packages: [], noDev: false, ignorePlatformReqs: false, dev: false };
  let named: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (flag === '-d' || flag === '--working-dir') request.workingDir = inline ?? args[++i];
    else if (flag === '--no-dev') request.noDev = true;
    else if (flag === '--dev') request.dev = true;
    else if (flag === '--ignore-platform-reqs') request.ignorePlatformReqs = true;
    else if (COMPOSER_VALUED.has(flag)) {
      if (inline === undefined) i++;
    } else if (flag.startsWith('-')) continue; // -n, --no-interaction, --prefer-dist, -o, --no-progress …: no effect here
    else if (named === undefined) named = arg;
    else request.packages.push(arg);
  }
  const command = COMPOSER_COMMANDS[named ?? 'install'];
  if (!command) return fail(`composer ${named} is not supported; the PHP runtime runs composer install, update, require and dump-autoload.`);
  request.command = command;
  if (command === 'require' && !request.packages.length) return fail('composer require needs a package (composer require vendor/name).');
  if (command !== 'require' && command !== 'update' && request.packages.length) return fail(`composer ${command} takes no packages.`);
  return ok({ kind: 'composer', ...request });
}

/**
 * The invocation with every path it names mapped by `map` (the project's
 * absolute VFS paths → where PHP sees them); relative paths stay relative.
 */
export function mapInvocationPaths(invocation: PhpInvocation, map: (path: string) => string): PhpInvocation {
  const mapped = (path: string | undefined) => (path?.startsWith('/') ? map(path) : path);
  switch (invocation.kind) {
    case 'serve':
      return {
        ...invocation,
        server: {
          ...invocation.server,
          docroot: mapped(invocation.server.docroot),
          router: mapped(invocation.server.router),
          ...(invocation.server.routerIfPresent === undefined ? {} : { routerIfPresent: mapped(invocation.server.routerIfPresent) }),
        },
      };
    case 'composer':
      return { ...invocation, workingDir: mapped(invocation.workingDir) };
    default: {
      // The script operand (the first non-option argument) is a path; other arguments are the program's.
      const argv = [...invocation.argv];
      for (let i = 0; i < argv.length; i++) {
        if (VALUED.has(argv[i]!)) {
          if (argv[i] === '-f') argv[i + 1] = mapped(argv[i + 1]) ?? '';
          if (argv[i] === '-r') break;
          i++;
          continue;
        }
        if (argv[i] === '--') break;
        if (argv[i]!.startsWith('-')) continue;
        argv[i] = mapped(argv[i]) ?? argv[i]!;
        break;
      }
      return { kind: 'cli', argv };
    }
  }
}
