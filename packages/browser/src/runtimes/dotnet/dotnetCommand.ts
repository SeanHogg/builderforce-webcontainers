/**
 * `dotnet` command lines, as the .NET runtime runs them: `dotnet run` (build,
 * then run; launch profiles; file-based `dotnet run app.cs`), `dotnet build`,
 * `dotnet <app.dll>` / `dotnet exec`, `dotnet restore` and `dotnet clean`
 * (bundled packages only), and the informational switches. Everything else —
 * `watch`, `test`, `publish`, `new`, tools — is declined with a reason, so the
 * host can say why or send the service to the container target.
 *
 * Paths stay as written (relative to the process's cwd); the Worker resolves
 * them. Unrecognised `dotnet run` options and everything after `--` go to the
 * program, as the real CLI forwards them.
 */
import { basename } from '@seanhogg/builderforce-webcontainers-core';

/** The command's base name, as a RegExp source (the process host's foreign commands). */
export const DOTNET_COMMAND_PATTERN = '^dotnet(?:\\.exe)?$';

const DOTNET = new RegExp(DOTNET_COMMAND_PATTERN);

export const isDotnetCommand = (command: string): boolean => DOTNET.test(basename(command));

export type DotnetInfo = 'version' | 'info' | 'list-sdks' | 'list-runtimes' | 'help';

export type DotnetInvocation =
  | { kind: 'info'; what: DotnetInfo }
  | { kind: 'restore'; project?: string }
  | { kind: 'clean'; project?: string; configuration: string }
  | { kind: 'build'; project?: string; configuration: string; output?: string }
  /** `file`: a file-based program (`dotnet run app.cs`, `dotnet app.cs`). `launchProfile: null`: `--no-launch-profile`. */
  | { kind: 'run'; project?: string; file?: string; configuration: string; noBuild: boolean; launchProfile?: string | null; appArgs: string[] }
  | { kind: 'exec'; assembly: string; appArgs: string[] };

export type DotnetCommandParse = { ok: true; invocation: DotnetInvocation } | { ok: false; reason: string };

const DECLINED: Readonly<Record<string, string>> = {
  watch: '`dotnet watch` is not available in the browser runtime: run `dotnet run`, and restart the service to pick up changes.',
  test: '`dotnet test` is not available in the browser runtime (no test host).',
  publish: '`dotnet publish` is not available in the browser runtime: `dotnet build` compiles, `dotnet run` runs.',
  pack: '`dotnet pack` is not available in the browser runtime.',
  new: '`dotnet new` is not available in the browser runtime: create the project files directly.',
  tool: '.NET tools are not available in the browser runtime.',
  ef: '`dotnet ef` is not available in the browser runtime: apply migrations from the program (`Database.Migrate()`), or run SQL.',
  add: '`dotnet add` is not available in the browser runtime: edit the project file (only bundled packages resolve).',
  remove: '`dotnet remove` is not available in the browser runtime: edit the project file.',
  sln: 'Solutions are not built in the browser runtime: build or run one project.',
  workload: 'Workloads are not available in the browser runtime.',
  nuget: 'NuGet commands are not available in the browser runtime.',
  'dev-certs': 'There is no TLS in the browser runtime: serve plain HTTP.',
  'user-secrets': '`dotnet user-secrets` is not available in the browser runtime: use environment variables.',
  msbuild: 'MSBuild is not available in the browser runtime: the runtime builds projects itself.',
};

const INFO: Readonly<Record<string, DotnetInfo>> = { '--version': 'version', '--info': 'info', '--list-sdks': 'list-sdks', '--list-runtimes': 'list-runtimes', '--help': 'help', '-h': 'help', '-?': 'help' };

/** Options that take a value and are ignored (the browser runtime has one target and one runtime). */
const IGNORED_WITH_VALUE = new Set(['-f', '--framework', '-r', '--runtime', '-v', '--verbosity', '-a', '--arch', '--os', '--source', '-s', '--packages', '--configfile']);
const IGNORED_FLAGS = new Set(['--nologo', '--no-restore', '--no-dependencies', '--interactive', '--force', '--no-incremental', '--self-contained', '--sc', '--no-self-contained', '--disable-build-servers', '--no-cache', '--use-current-runtime', '--ucr']);

/** `-p:Name=Value` / `--property:Name=Value` / `/p:Name=Value`: only Configuration is honoured. */
const PROPERTY = /^(?:-p|--property|\/p|\/property):(.+)$/i;

const isSourceFile = (arg: string) => /\.cs$/i.test(arg);
const isAssembly = (arg: string) => /\.dll$/i.test(arg);

interface Options {
  positional: string[];
  forwarded: string[];
  project?: string;
  configuration?: string;
  output?: string;
  noBuild: boolean;
  launchProfile?: string | null;
}

/** Read a subcommand's options; `run` forwards what it does not know to the program. */
function readOptions(args: string[], forward: boolean): { ok: true; options: Options } | { ok: false; reason: string } {
  const options: Options = { positional: [], forwarded: [], noBuild: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => {
      const next = args[++i];
      if (next === undefined) throw new Error(`Required argument missing for option: '${arg}'.`);
      return next;
    };
    try {
      if (arg === '--') {
        options.forwarded.push(...args.slice(i + 1));
        break;
      }
      const property = PROPERTY.exec(arg);
      if (property) {
        // `-p:Configuration=Release;X=Y` sets several properties: each `Name=Value` after a `;`.
        for (const assignment of property[1]!.split(';')) {
          const at = assignment.indexOf('=');
          if (at > 0 && assignment.slice(0, at).trim().toLowerCase() === 'configuration' && assignment.slice(at + 1).trim()) options.configuration = assignment.slice(at + 1).trim();
        }
      } else if (arg === '--project' || arg === '-p' || (arg === '--file' && forward)) options.project = value();
      else if (arg === '-c' || arg === '--configuration') options.configuration = value();
      else if (arg === '-o' || arg === '--output') options.output = value();
      else if (arg === '--no-build') options.noBuild = true;
      else if (arg === '--launch-profile' || arg === '-lp') options.launchProfile = value();
      else if (arg === '--no-launch-profile') options.launchProfile = null;
      else if (IGNORED_WITH_VALUE.has(arg)) value();
      else if (IGNORED_FLAGS.has(arg) || /^--tl(?::|$)/.test(arg) || /^-(?:v|-verbosity):/.test(arg)) continue;
      else if (arg.startsWith('-') && forward) options.forwarded.push(arg);
      else if (arg.startsWith('-')) return { ok: false, reason: `Unknown option '${arg}'.` };
      else {
        options.positional.push(arg);
        if (forward) options.forwarded.push(arg);
      }
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }
  return { ok: true, options };
}

function parseRun(args: string[]): DotnetCommandParse {
  const read = readOptions(args, true);
  if (!read.ok) return read;
  const { options } = read;
  const configuration = options.configuration ?? 'Debug';
  // `dotnet run app.cs`: the first argument names a file-based program; any other positional goes to the program.
  // `forwarded` holds the program's arguments in order: positionals, unknown options, everything after `--`.
  const first = options.positional[0];
  if (!options.project && first && isSourceFile(first)) {
    const appArgs = [...options.forwarded];
    appArgs.splice(appArgs.indexOf(first), 1);
    return { ok: true, invocation: { kind: 'run', file: first, configuration, noBuild: false, launchProfile: null, appArgs } };
  }
  if (options.project && isSourceFile(options.project)) {
    return { ok: true, invocation: { kind: 'run', file: options.project, configuration, noBuild: false, launchProfile: null, appArgs: options.forwarded } };
  }
  return { ok: true, invocation: { kind: 'run', project: options.project, configuration, noBuild: options.noBuild, launchProfile: options.launchProfile, appArgs: options.forwarded } };
}

function parseProjectCommand(kind: 'build' | 'clean' | 'restore', args: string[]): DotnetCommandParse {
  const read = readOptions(args, false);
  if (!read.ok) return read;
  const { options } = read;
  if (options.positional.length > 1) return { ok: false, reason: `Only one project can be specified (got ${options.positional.join(', ')}).` };
  const project = options.positional[0] ?? options.project;
  if (project && /\.(?:sln|slnx)$/i.test(project)) return { ok: false, reason: DECLINED.sln! };
  const configuration = options.configuration ?? 'Debug';
  if (kind === 'restore') return { ok: true, invocation: { kind, project } };
  if (kind === 'clean') return { ok: true, invocation: { kind, project, configuration } };
  return { ok: true, invocation: { kind, project, configuration, output: options.output } };
}

/** Parse a `dotnet` command line (`command` is `dotnet` or a path to it). */
export function parseDotnetCommand(command: string, args: string[]): DotnetCommandParse {
  if (!isDotnetCommand(command)) return { ok: false, reason: `"${command}" is not dotnet.` };
  const [verb, ...rest] = args;
  if (verb === undefined) return { ok: true, invocation: { kind: 'info', what: 'help' } };
  const info = INFO[verb];
  if (info) return { ok: true, invocation: { kind: 'info', what: info } };
  if (verb === 'run') return parseRun(rest);
  if (verb === 'build' || verb === 'clean' || verb === 'restore') return parseProjectCommand(verb, rest);
  if (verb === 'exec') {
    const [assembly, ...appArgs] = rest;
    if (!assembly || !isAssembly(assembly)) return { ok: false, reason: '`dotnet exec` needs the path to an application assembly (app.dll).' };
    return { ok: true, invocation: { kind: 'exec', assembly, appArgs } };
  }
  if (isAssembly(verb)) return { ok: true, invocation: { kind: 'exec', assembly: verb, appArgs: rest } };
  if (isSourceFile(verb)) return parseRun(args);
  const declined = DECLINED[verb];
  if (declined) return { ok: false, reason: declined };
  if (verb.startsWith('-')) return { ok: false, reason: `Unknown option '${verb}'.` };
  return { ok: false, reason: `\`dotnet ${verb}\` is not available in the browser runtime (it runs run, build, clean, restore and app.dll).` };
}
