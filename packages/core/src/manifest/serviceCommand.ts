/**
 * A manifest's command lines — a service's `command`, a job's `run.command` —
 * read ONCE, here, for both `validateManifest` (what can be told without a
 * target) and `toApplicationSpec` (the spec's program and arguments, and whether
 * a shell line can run, which depend on the runtime and the target). Both report
 * through {@link commandLineIssues}; `toApplicationSpec`'s `dedupeIssues` keeps
 * one copy of each, and it re-reads warnings from the EFFECTIVE (overridden)
 * commands only ({@link isCommandLineWarning}).
 */
import type { ServiceSpec } from '../app/spec.js';
import { splitCommandLine, type CommandLine } from '../shell/commandLine.js';
import { JOB_CAPABILITIES } from './capabilities.js';
import { manifestIssue, type ManifestIssue } from './issues.js';
import type { JobSpec, ManifestService, ManifestTargetId } from './types.js';

/** Where a shell line can run: `bfsh -c` exists only in the browser runtime, and only node services run it. */
const SHELL_RUNTIME = 'node';
const SHELL_TARGET: ManifestTargetId = 'browser';

const hasShell = (runtime: string, target: ManifestTargetId) => runtime === SHELL_RUNTIME && target === SHELL_TARGET;

function shellUnsupported(path: string, command: string, runtime: string, target: ManifestTargetId): ManifestIssue {
  const where = runtime === SHELL_RUNTIME ? `the ${target} target has no shell to run it` : `the ${runtime} runtime has no shell to run it`;
  return manifestIssue('shell-command-unsupported', `${path}.command`, { value: command, detail: `Only node services on the ${SHELL_TARGET} target run a command through the shell (bfsh); ${where}.` });
}

/** Issues a command line has whatever the target: unreadable, a shell line with `args`, a backslash the shell drops. */
export function commandLineIssues(path: string, command: string, args: readonly unknown[] | undefined, line: CommandLine = splitCommandLine(command)): ManifestIssue[] {
  if (line.kind === 'invalid') return [manifestIssue('invalid-value', `${path}.command`, { value: command, detail: `The command line cannot be read: ${line.reason}.` })];
  const issues: ManifestIssue[] = [];
  if (line.kind === 'shell' && args !== undefined && args.length > 0) issues.push(manifestIssue('shell-command-with-args', `${path}.args`, { value: command }));
  if (line.strayBackslash) issues.push(manifestIssue('command-backslash', `${path}.command`, { severity: 'warning', value: command }));
  return issues;
}

/** A warning `toApplicationSpec` reads again from the effective command, so the base manifest's copy (maybe of a replaced command) is dropped. */
export function isCommandLineWarning(issue: ManifestIssue): boolean {
  return issue.code === 'command-backslash';
}

/**
 * The spec's `command` + `args` for a service on `target`: plain words split
 * into the program and its leading arguments (before the manifest's `args`); a
 * shell line runs as `bfsh -c <line>` for a node service on the browser target,
 * and is a `shell-command-unsupported` issue anywhere else. Issues go to `issues`.
 */
export function serviceCommand(id: string, service: ManifestService, target: ManifestTargetId, issues: ManifestIssue[]): Pick<ServiceSpec, 'command' | 'args'> {
  const extra = service.args ?? [];
  const path = `services.${id}`;
  const line = splitCommandLine(service.command);
  issues.push(...commandLineIssues(path, service.command, extra, line));
  if (line.kind === 'argv') {
    const [program, ...rest] = line.argv;
    const args = [...rest, ...extra];
    return args.length > 0 ? { command: program, args } : { command: program };
  }
  if (line.kind === 'shell') {
    // With `args` it is a `shell-command-with-args` error already: joined as text, a `#` or a trailing `&` would swallow them.
    if (hasShell(service.runtime, target) && extra.length === 0) return { command: 'bfsh', args: ['-c', line.line] };
    if (!hasShell(service.runtime, target)) issues.push(shellUnsupported(path, service.command, service.runtime, target));
  }
  // Already an error above: the spec keeps the line as written, and is never produced.
  return extra.length > 0 ? { command: service.command, args: [...extra] } : { command: service.command };
}

/**
 * A job's `run.command` on `target`: its command-line issues, and — on a target
 * that runs jobs — `shell-command-unsupported` for a shell line its service's
 * runtime cannot run there (the same rule as a service's command).
 */
export function jobCommandIssues(id: string, job: JobSpec, services: Readonly<Record<string, ManifestService>>, target: ManifestTargetId): ManifestIssue[] {
  const run = job.run;
  if (!run || typeof run.command !== 'string') return [];
  const path = `jobs.${id}.run`;
  const line = splitCommandLine(run.command);
  const issues = commandLineIssues(path, run.command, undefined, line);
  const runtime = services[run.service]?.runtime;
  if (line.kind === 'shell' && runtime !== undefined && JOB_CAPABILITIES[target].supported && !hasShell(runtime, target)) issues.push(shellUnsupported(path, run.command, runtime, target));
  return issues;
}
