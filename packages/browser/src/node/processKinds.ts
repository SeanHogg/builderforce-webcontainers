/**
 * The seam through which other process kinds plug into the process host,
 * without the host knowing them: which Worker kind runs a command (and the
 * command line it gets), what that kind's start message carries, and the
 * messages only that kind sends. The Python, PHP and .NET runtimes implement it
 * (runtimes/python/pythonProcessKind.ts, runtimes/php/phpProcessKind.ts,
 * runtimes/dotnet/dotnetProcessKind.ts — the .NET policy chains to the PHP one,
 * the PHP policy to the Python one); with no policy every process is Node.
 */
import type { SecurityContext, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { StartMessage, WorkerKind } from './protocol.js';

export interface ProcessRoute {
  kind: WorkerKind;
  command: string;
  args: string[];
}

export interface ProcessKindPolicy {
  /** The Worker kind that runs `command` (a script's shebang may decide), and the command line it is given. */
  route(command: string, args: string[], context: { fs: VirtualFileSystem; cwd: string; env: Record<string, string> }): ProcessRoute;
  /** What a `kind` process's start message carries beyond the common fields; `context` is who the process is (the page-side record). */
  startOptions(kind: WorkerKind, context: SecurityContext): Pick<StartMessage, 'python' | 'php' | 'dotnet'>;
  /** A message the host does not handle itself, from a process of `kind`; true when taken. `context` is the sender, from the page-side record of its Worker — never from the message. */
  receive(kind: WorkerKind, message: unknown, context: SecurityContext): boolean;
  /** Process `pid` is gone (its record cleaned up, however it ended): drop whatever the policy holds for it. A chained policy forwards it to its `next`. */
  exited(pid: number): void;
  /** Commands Node processes must hand to the page rather than resolve (a RegExp source over the base name). */
  readonly foreignCommands?: string;
}

/** Several policies' `foreignCommands` as one RegExp source (a chained policy's own and its `next`'s); undefined when none has any. */
export function unionCommandPatterns(...patterns: Array<string | undefined>): string | undefined {
  const present = patterns.filter((pattern): pattern is string => !!pattern);
  return present.length ? present.map((pattern) => `(?:${pattern})`).join('|') : undefined;
}

/** Every process is a Node process. */
export const NODE_ONLY: ProcessKindPolicy = {
  route: (command, args) => ({ kind: 'node', command, args }),
  startOptions: () => ({}),
  receive: () => false,
  exited: () => undefined,
};
