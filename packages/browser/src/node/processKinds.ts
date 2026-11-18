/**
 * The seam through which other process kinds plug into the process host,
 * without the host knowing them: which Worker kind runs a command (and the
 * command line it gets), what that kind's start message carries, and the
 * messages only that kind sends. The Python and PHP runtimes implement it
 * (runtimes/python/pythonProcessKind.ts, runtimes/php/phpProcessKind.ts — the
 * PHP policy chains to the Python one); with no policy every process is Node.
 */
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { StartMessage, WorkerKind } from './protocol.js';

export interface ProcessRoute {
  kind: WorkerKind;
  command: string;
  args: string[];
}

export interface ProcessKindPolicy {
  /** The Worker kind that runs `command` (a script's shebang may decide), and the command line it is given. */
  route(command: string, args: string[], context: { fs: VirtualFileSystem; cwd: string; env: Record<string, string> }): ProcessRoute;
  /** What a `kind` process's start message carries beyond the common fields. */
  startOptions(kind: WorkerKind): Pick<StartMessage, 'python' | 'php'>;
  /** A message the host does not handle itself, from a process of `kind`; true when taken. */
  receive(kind: WorkerKind, message: unknown): boolean;
  /** Commands Node processes must hand to the page rather than resolve (a RegExp source over the base name). */
  readonly foreignCommands?: string;
}

/** Every process is a Node process. */
export const NODE_ONLY: ProcessKindPolicy = {
  route: (command, args) => ({ kind: 'node', command, args }),
  startOptions: () => ({}),
  receive: () => false,
};
