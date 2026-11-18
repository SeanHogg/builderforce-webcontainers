/**
 * What a Python command line asks for, as the Python runtime runs it: a script,
 * `-c` code, a `-m` module, a `pip install`, or an ASGI/WSGI app served
 * request-driven (serverCommand.ts). Pure: no Pyodide, no file system.
 */
import { parseServerCommand, SERVER_COMMANDS, type AppServerSpec } from './serverCommand.js';

export type { AppInterface, AppServerSpec } from './serverCommand.js';

export interface InstallRequest {
  /** Requirement specs (`fastapi`, `pkg==1.0`). */
  packages: string[];
  /** Requirement files (`-r requirements.txt`). */
  files: string[];
  /** Project directories (`pip install .`, `-e .`): their pyproject/requirements dependencies. */
  projects: string[];
  /** `-i`/`--index-url`, then `--extra-index-url`s. */
  indexUrls: string[];
}

export type PythonInvocation =
  /** `argv` is `sys.argv`: the script path, then its arguments. */
  | { kind: 'script'; path: string; argv: string[] }
  | { kind: 'code'; code: string; argv: string[] }
  | { kind: 'module'; module: string; argv: string[] }
  | ({ kind: 'install' } & InstallRequest)
  | { kind: 'serve'; server: AppServerSpec };

export type PythonCommandParse = { ok: true; invocation: PythonInvocation } | { ok: false; reason: string };

const INTERPRETERS = /^(python(3(\.\d+)?)?|py)(\.exe)?$/;
const PIPS = /^pip(3(\.\d+)?)?(\.exe)?$/;
/** Interpreter flags that take the next argument as their value. */
const FLAGS_WITH_VALUE = new Set(['-W', '-X', '-Q']);
/** `pip install` options whose value is the next argument (or after `=`). */
const PIP_VALUED = new Set([
  '-c', '--constraint', '-t', '--target', '--prefix', '--root', '--src', '-f', '--find-links', '--platform', '--python-version',
  '--implementation', '--abi', '--upgrade-strategy', '--progress-bar', '--config-settings', '-C', '--global-option', '--report',
  '--no-binary', '--only-binary', '--hash', '--trusted-host', '--cert', '--client-cert', '--cache-dir', '--log', '--proxy', '--retries', '--timeout',
]);

const basename = (command: string) => command.replace(/\\/g, '/').split('/').pop() ?? command;

/**
 * Every command name the Python runtime runs, as one RegExp source over a base
 * name — what Node processes are told to hand to the page (`foreignCommands`).
 */
export const PYTHON_COMMAND_PATTERN = `^(?:${INTERPRETERS.source.slice(1, -1)}|${PIPS.source.slice(1, -1)}|${[...SERVER_COMMANDS].map((name) => name.replace(/[-.]/g, '\\$&')).join('|')})$`;
const PYTHON_COMMAND = new RegExp(PYTHON_COMMAND_PATTERN);

/** Whether the Python runtime (not Node) runs `command`. */
export function isPythonCommand(command: string): boolean {
  return PYTHON_COMMAND.test(basename(command));
}

const fail = (reason: string): PythonCommandParse => ({ ok: false, reason });
const ok = (invocation: PythonInvocation): PythonCommandParse => ({ ok: true, invocation });

/** Parse `command args…`; `env` supplies `PORT` and `FLASK_APP` defaults. */
export function parsePythonCommand(command: string, args: readonly string[], env: Readonly<Record<string, string>> = {}): PythonCommandParse {
  const name = basename(command);
  if (PIPS.test(name)) return parsePip(args);
  if (SERVER_COMMANDS.has(name)) return served(parseServerCommand(name, args, env));
  if (INTERPRETERS.test(name)) return parseInterpreter(args, env);
  return fail(`"${command}" is not a Python command.`);
}

function served(result: { ok: true; server: AppServerSpec } | { ok: false; reason: string }): PythonCommandParse {
  return result.ok ? ok({ kind: 'serve', server: result.server }) : fail(result.reason);
}

function parseInterpreter(args: readonly string[], env: Readonly<Record<string, string>>): PythonCommandParse {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-c') {
      const code = args[i + 1];
      return code === undefined ? fail('Argument expected for the -c option.') : ok({ kind: 'code', code, argv: ['-c', ...args.slice(i + 2)] });
    }
    if (arg === '-m') {
      const module = args[i + 1];
      if (module === undefined) return fail('Argument expected for the -m option.');
      const rest = args.slice(i + 2);
      if (module === 'pip') return parsePip(rest);
      if (SERVER_COMMANDS.has(module)) return served(parseServerCommand(module, rest, env));
      return ok({ kind: 'module', module, argv: [module, ...rest] });
    }
    if (FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') continue; // -u, -B, -I, -O …: no effect on what runs
    return ok({ kind: 'script', path: arg, argv: args.slice(i) as string[] });
  }
  return fail('Interactive Python (no script, -c or -m) needs a terminal, which the Python runtime does not provide.');
}

/** A `pip install` target that names a directory (`.`, `./api`, `/srv`), not a requirement. */
const isProjectPath = (arg: string) => arg === '.' || arg === '..' || arg.startsWith('./') || arg.startsWith('../') || arg.startsWith('/');

function parsePip(args: readonly string[]): PythonCommandParse {
  if (args[0] !== 'install') return fail(`pip ${args[0] ?? ''}`.trim() + ' is not supported; the Python runtime only installs (pip install).');
  const request: InstallRequest = { packages: [], files: [], projects: [], indexUrls: [] };
  const extraIndexUrls: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => inline ?? args[++i];
    if (flag === '-r' || flag === '--requirement') {
      const file = value();
      if (file) request.files.push(file);
    } else if (flag === '-e' || flag === '--editable') {
      const target = value();
      if (target && isProjectPath(target)) request.projects.push(target);
      else return fail(`Editable installs of "${target ?? ''}" are not supported; the Python runtime installs a local project's dependencies (pip install -e .).`);
    } else if (flag === '-i' || flag === '--index-url') {
      const url = value();
      if (url) request.indexUrls.unshift(url);
    } else if (flag === '--extra-index-url') {
      const url = value();
      if (url) extraIndexUrls.push(url);
    } else if (PIP_VALUED.has(flag)) {
      if (inline === undefined) i++;
    } else if (!arg.startsWith('-')) {
      if (isProjectPath(arg)) request.projects.push(arg);
      else request.packages.push(arg);
    }
  }
  request.indexUrls.push(...extraIndexUrls);
  if (!request.packages.length && !request.files.length && !request.projects.length) return fail('pip install needs a package, a project directory or -r <requirements file>.');
  return ok({ kind: 'install', ...request });
}

/**
 * The invocation with every path it names mapped by `map` (the project's
 * absolute VFS paths → where Python sees them); relative paths stay relative.
 */
export function mapInvocationPaths(invocation: PythonInvocation, map: (path: string) => string): PythonInvocation {
  const mapped = (path: string) => (path.startsWith('/') ? map(path) : path);
  switch (invocation.kind) {
    case 'script':
      return { ...invocation, path: mapped(invocation.path), argv: [mapped(invocation.path), ...invocation.argv.slice(1)] };
    case 'install':
      return { ...invocation, files: invocation.files.map(mapped), projects: invocation.projects.map(mapped) };
    case 'serve':
      return invocation.server.appDir ? { ...invocation, server: { ...invocation.server, appDir: mapped(invocation.server.appDir) } } : invocation;
    default:
      return invocation;
  }
}
