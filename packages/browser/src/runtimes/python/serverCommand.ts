/**
 * App-server command lines (`uvicorn main:app --port 8000`, `gunicorn app:app`,
 * `flask run`, `fastapi run`) as the app spec the runtime serves request-driven.
 * The servers are not run: the runtime imports the app and calls it per request
 * on the service's virtual port, so the familiar command line is the declaration.
 */

/** How an app is called per request. */
export type AppInterface = 'asgi' | 'wsgi';

/** A Python web app to serve on a virtual port. */
export interface AppServerSpec {
  interface: AppInterface;
  /** `module:attribute` (`main:app`), or a bare module whose `app`/`application`/`create_app` is found. */
  app: string;
  port: number;
  /** Call the attribute to get the app (`--factory`, or `name()`). */
  factory?: boolean;
  /** A directory (relative to the cwd, or a project path) put first on `sys.path` (`--app-dir`). */
  appDir?: string;
}

/** The app servers whose command line the runtime reads instead of running. */
export const SERVER_COMMANDS: ReadonlySet<string> = new Set(['uvicorn', 'hypercorn', 'gunicorn', 'waitress-serve', 'flask', 'fastapi']);

export type ServerParse = { ok: true; server: AppServerSpec } | { ok: false; reason: string };

/** Each server's options that take a value (the next argument, or after `=`). */
const VALUED: Readonly<Record<string, readonly string[]>> = {
  uvicorn: ['--host', '--port', '--app-dir', '--root-path', '--log-level', '--workers', '--env-file', '--uds', '--fd', '--lifespan', '--loop', '--http', '--ws', '--interface', '--log-config', '--reload-dir', '--reload-include', '--reload-exclude', '--reload-delay', '--limit-concurrency', '--limit-max-requests', '--backlog', '--timeout-keep-alive', '--ssl-keyfile', '--ssl-certfile', '--forwarded-allow-ips', '--header', '--h11-max-incomplete-event-size', '--ws-max-size', '--ws-ping-interval', '--ws-ping-timeout'],
  hypercorn: ['-b', '--bind', '-w', '--workers', '-k', '--worker-class', '-c', '--config', '--root-path', '--log-level', '--access-logfile', '--error-logfile', '--keep-alive', '--graceful-timeout', '-m', '--umask', '-u', '--user', '-g', '--group'],
  gunicorn: ['-b', '--bind', '-w', '--workers', '-k', '--worker-class', '-c', '--config', '--chdir', '-t', '--timeout', '--log-level', '--threads', '--access-logfile', '--error-logfile', '-e', '--env', '-n', '--name', '--pythonpath', '-p', '--pid', '--max-requests', '--graceful-timeout', '--keep-alive', '-u', '--user', '-g', '--group'],
  'waitress-serve': ['--host', '--port', '--listen', '--threads', '--url-scheme', '--url-prefix', '--ident', '--call'],
  flask: ['--app', '-A', '--host', '-h', '--port', '-p', '--cert', '--key', '--extra-files', '--exclude-patterns', '-e', '--env-file'],
  fastapi: ['--host', '--port', '--app', '--root-path', '--entrypoint', '--workers', '--proxy-headers', '--forwarded-allow-ips'],
};

const DEFAULT_PORTS: Readonly<Record<string, number>> = { uvicorn: 8000, hypercorn: 8000, gunicorn: 8000, 'waitress-serve': 8080, flask: 5000, fastapi: 8000 };

/** The value of the first matching option (`--port 8000`, `--port=8000`, `-p 8000`). */
function option(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    for (const name of names) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Positional arguments, skipping options and the values of `valued` ones. */
function positionals(args: readonly string[], valued: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valued.includes(arg)) i++;
    else if (!arg.startsWith('-')) out.push(arg);
  }
  return out;
}

/**
 * The app among the positionals: the one naming `module:attribute`, else the
 * last one — so the value of an option this parser does not know (`--foo bar
 * app`) is never taken for the app.
 */
const appOf = (candidates: readonly string[]) => candidates.find((arg) => arg.includes(':')) ?? candidates[candidates.length - 1];

/** The port of `host:port`, `:port`, `*:port` or `port`. */
const portOfBind = (bind: string | undefined) => (bind === undefined ? undefined : bind.split(':').pop());

function toPort(value: string | undefined, env: Readonly<Record<string, string>>, fallback: number): number | string {
  const raw = value ?? env.PORT;
  if (raw === undefined) return fallback;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : `Invalid port "${raw}".`;
}

/** `app/main.py` → module `main` in directory `app` (fastapi's file argument). */
function fileTarget(file: string): { module: string; dir?: string } {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const cut = normalized.lastIndexOf('/');
  const name = normalized.slice(cut + 1).replace(/\.py$/, '');
  return cut < 0 ? { module: name } : { module: name, dir: normalized.slice(0, cut) || '/' };
}

export function parseServerCommand(server: string, args: readonly string[], env: Readonly<Record<string, string>>): ServerParse {
  const valued = VALUED[server];
  if (!valued) return { ok: false, reason: `"${server}" is not a supported Python app server.` };
  const fail = (reason: string): ServerParse => ({ ok: false, reason: `${server}: ${reason}` });
  const free = positionals(args, valued);
  let app: string | undefined;
  let iface: AppInterface = 'asgi';
  let portValue: string | undefined;
  let appDir: string | undefined;
  switch (server) {
    case 'uvicorn': {
      const declared = option(args, ['--interface']) ?? 'auto';
      if (declared === 'asgi2') return fail('ASGI 2 (double-callable) apps are not supported; use an ASGI 3 app.');
      iface = declared === 'wsgi' ? 'wsgi' : 'asgi';
      app = appOf(free);
      portValue = option(args, ['--port']);
      appDir = option(args, ['--app-dir']);
      break;
    }
    case 'hypercorn':
      app = appOf(free);
      portValue = portOfBind(option(args, ['-b', '--bind']));
      break;
    case 'gunicorn':
      iface = /uvicorn|asgi/i.test(option(args, ['-k', '--worker-class']) ?? '') ? 'asgi' : 'wsgi';
      app = appOf(free);
      portValue = portOfBind(option(args, ['-b', '--bind']));
      appDir = option(args, ['--chdir']);
      break;
    case 'waitress-serve':
      iface = 'wsgi';
      app = appOf(free);
      portValue = option(args, ['--port']) ?? portOfBind(option(args, ['--listen']));
      break;
    case 'flask':
      iface = 'wsgi';
      if (!free.includes('run')) return fail('only "flask run" is supported by the Python runtime.');
      app = option(args, ['--app', '-A']) ?? env.FLASK_APP ?? 'app';
      portValue = option(args, ['--port', '-p']);
      break;
    case 'fastapi': {
      const [verb, file] = free;
      if (verb !== 'run' && verb !== 'dev') return fail('only "fastapi run" and "fastapi dev" are supported by the Python runtime.');
      const entry = option(args, ['--entrypoint']);
      if (entry) app = entry;
      else {
        const target = fileTarget(file ?? 'main.py');
        const attribute = option(args, ['--app']);
        app = attribute ? `${target.module}:${attribute}` : target.module;
        appDir = target.dir;
      }
      portValue = option(args, ['--port']);
      break;
    }
  }
  if (!app) return fail('no application given (expected module:app).');
  const port = toPort(portValue, env, DEFAULT_PORTS[server]!);
  if (typeof port === 'string') return fail(port);
  const factory = args.includes('--factory') || app.endsWith('()');
  return { ok: true, server: { interface: iface, app: app.replace(/\(\)$/, ''), port, ...(factory ? { factory } : {}), ...(appDir ? { appDir } : {}) } };
}
