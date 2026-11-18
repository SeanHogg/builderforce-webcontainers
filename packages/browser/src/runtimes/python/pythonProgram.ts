/**
 * Running what a Python command line asked for (`parsePythonCommand`) in a
 * started interpreter. Every invocation first gets its packages: what earlier
 * `pip install`s in this session recorded (pipRecord.ts) and the project's own
 * requirements (`requirements.txt` / `pyproject.toml` in its directory). Then
 * a script, `-c` code or `-m` module runs to its exit code (Pyodide-built
 * packages it imports are loaded first) — or serves, if it called
 * `uvicorn.run`; a `pip install` installs and reports what it added; an app
 * named on the command line is served request-driven.
 */
import { startPythonAppServer, startRequestedAppServer, type PythonAppServer } from './appServer.js';
import { describeInstall, installRequirements, type InstallReport } from './installRequirements.js';
import type { PipInstall } from './pipRecord.js';
import type { PythonInvocation } from './pythonCommand.js';
import type { ProvidedPackages } from './pythonExtensions.js';
import type { PyodideLike, PyProxyLike } from './pyodideLoader.js';
import { parseRequirement, readProjectRequirements, readRequirementFile, resolveFrom, type Requirement } from './requirements.js';

export interface PythonProgramIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** `pip install` added these (the page records them for later processes). */
  installed?(install: PipInstall): void;
}

export interface PythonProgramContext {
  /** The working directory, a Pyodide path. */
  cwd: string;
  env: Readonly<Record<string, string>>;
  io: PythonProgramIo;
  /** The session's earlier `pip install`s (the host's record). */
  installs: PipInstall[];
  /** What host extensions already satisfy. */
  provided: ProvidedPackages;
}

export type ProgramOutcome = { kind: 'exited'; code: number } | { kind: 'serving'; server: PythonAppServer };

const decoder = new TextDecoder();

/** A text file in Pyodide's file system (relative paths against `cwd`), or undefined when absent or a directory. */
export function pyodideTextReader(pyodide: PyodideLike, cwd: string): (path: string) => string | undefined {
  return (path) => {
    const absolute = resolveFrom(cwd, path);
    if (!pyodide.FS.analyzePath(absolute).exists || pyodide.FS.isDir(pyodide.FS.stat(absolute).mode)) return undefined;
    return decoder.decode(pyodide.FS.readFile(absolute));
  };
}

const specsOf = (specs: readonly string[]) => specs.map(parseRequirement).filter((requirement): requirement is Requirement => !!requirement);

/** `PIP_INDEX_URL`, then `PIP_EXTRA_INDEX_URL`s (space-separated), as pip reads them. */
const envIndexUrls = (env: Readonly<Record<string, string>>) => [env.PIP_INDEX_URL, ...(env.PIP_EXTRA_INDEX_URL ?? '').split(/\s+/)].filter((url): url is string => !!url);

async function runMain(pyodide: PyodideLike, kind: 'script' | 'code' | 'module', target: string, argv: readonly string[]): Promise<number | 'serve'> {
  const globals = pyodide.toPy({ kind, target, argv: [...argv] });
  try {
    // A promising call: blocking virtual sockets (`run_sync`) work beneath it where JSPI exists.
    const code = await pyodide.runPythonAsync('from bfwc.run import run_main\nrun_main(kind, target, argv)', { globals });
    return code === 'serve' ? 'serve' : typeof code === 'number' ? code : 0;
  } finally {
    globals.destroy?.();
  }
}

/**
 * Load the Pyodide-built packages `source` imports — except what an extension
 * provides; a failure is reported and the program still runs (its import fails
 * with Python's own error).
 */
async function preloadImports(pyodide: PyodideLike, source: string | undefined, context: PythonProgramContext): Promise<void> {
  if (!source) return;
  try {
    const findImports = pyodide.pyimport('pyodide.code').find_imports as (code: string) => PyProxyLike;
    const found = findImports(source);
    const names = (found.toJs?.() as string[] | undefined) ?? [];
    found.destroy?.();
    const wanted = names.filter((name) => !context.provided.imports.has(name.split('.')[0]!));
    if (!wanted.length) return;
    await pyodide.loadPackagesFromImports(wanted.map((name) => `import ${name}`).join('\n'), { messageCallback: () => undefined, errorCallback: (message) => context.io.stderr(`${message}\n`) });
  } catch (error) {
    context.io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * The session's earlier `pip install`s — each with only its own indexes; one
 * that cannot be repeated (an index gone) is a warning — then the project's
 * requirements in `dir`, from the default index or the process's
 * `PIP_INDEX_URL`, never a recorded one. Declines are reported on stderr.
 */
async function installEnvironment(pyodide: PyodideLike, dir: string, context: PythonProgramContext): Promise<void> {
  const log = (line: string) => context.io.stderr(`${line}\n`);
  const declined = (report: InstallReport) => report.declined.forEach(({ reason }) => log(`Declined: ${reason}`));
  for (const install of context.installs) {
    try {
      declined(await installRequirements(pyodide, specsOf(install.specs), { indexUrls: install.indexUrls, log, provided: context.provided.packages }));
    } catch (error) {
      log(`Warning: could not repeat this session's earlier pip install of ${install.specs.join(' ')}: ${error instanceof Error ? error.message.trim().split('\n').pop() : String(error)}`);
    }
  }
  const requirements = readProjectRequirements(pyodideTextReader(pyodide, context.cwd), dir);
  if (requirements.length) declined(await installRequirements(pyodide, requirements, { indexUrls: envIndexUrls(context.env), log, provided: context.provided.packages }));
  // After installs, so the frameworks that use thread pools are there to patch.
  (pyodide.pyimport('bfwc.threads').install as () => void)();
}

async function pipInstall(pyodide: PyodideLike, invocation: Extract<PythonInvocation, { kind: 'install' }>, context: PythonProgramContext): Promise<number> {
  const read = pyodideTextReader(pyodide, context.cwd);
  const fromProjects = invocation.projects.flatMap((project) => {
    const dir = resolveFrom(context.cwd, project);
    const requirements = readProjectRequirements(read, dir);
    if (!requirements.length) context.io.stderr(`${project}: no dependencies declared (pyproject.toml [project] dependencies or requirements.txt); its own code runs from the project directory as is.\n`);
    return requirements;
  });
  const requested = [...specsOf(invocation.packages), ...invocation.files.flatMap((file) => readRequirementFile(read, resolveFrom(context.cwd, file))), ...fromProjects];
  const indexUrls = [...invocation.indexUrls, ...envIndexUrls(context.env)];
  const report: InstallReport = await installRequirements(pyodide, requested, { indexUrls, log: (line) => context.io.stderr(`${line}\n`), provided: context.provided.packages });
  for (const line of describeInstall(report)) (line.startsWith('Declined') ? context.io.stderr : context.io.stdout)(`${line}\n`);
  const installed = requested.filter((requirement) => report.installed.includes(requirement.name)).map((requirement) => requirement.spec);
  // The indexes this install used (its options and the process's PIP_INDEX_URL) travel with it, and only with it.
  if (installed.length) context.io.installed?.({ specs: installed, indexUrls });
  return report.declined.length ? 1 : 0;
}

/** Run `invocation` (its paths already Pyodide paths). */
export async function runPythonInvocation(pyodide: PyodideLike, invocation: PythonInvocation, context: PythonProgramContext): Promise<ProgramOutcome> {
  const exited = (code: number): ProgramOutcome => ({ kind: 'exited', code });
  if (invocation.kind === 'install') {
    (pyodide.pyimport('bfwc.threads').install as () => void)();
    return exited(await pipInstall(pyodide, invocation, context));
  }
  const projectDir = invocation.kind === 'serve' && invocation.server.appDir ? resolveFrom(context.cwd, invocation.server.appDir) : context.cwd;
  await installEnvironment(pyodide, projectDir, context);
  if (invocation.kind === 'serve') return { kind: 'serving', server: await startPythonAppServer(pyodide, invocation.server) };
  const read = pyodideTextReader(pyodide, context.cwd);
  let result: number | 'serve';
  if (invocation.kind === 'script') {
    await preloadImports(pyodide, read(invocation.path), context);
    result = await runMain(pyodide, 'script', invocation.path, invocation.argv);
  } else if (invocation.kind === 'code') {
    await preloadImports(pyodide, invocation.code, context);
    result = await runMain(pyodide, 'code', invocation.code, invocation.argv);
  } else result = await runMain(pyodide, 'module', invocation.module, invocation.argv);
  return result === 'serve' ? { kind: 'serving', server: await startRequestedAppServer(pyodide) } : exited(result);
}
