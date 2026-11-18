/**
 * The .NET runtime's process-kind policy for the process host
 * (node/processKinds.ts): `dotnet` commands — and file-based programs whose
 * shebang names dotnet (`#!/usr/bin/env dotnet`, run as `./app.cs`) — run in
 * a .NET process Worker, whose start message carries the host's instructions
 * (where the runtime bundle is served). Every other command goes to `next`, so
 * one host chains the runtimes:
 * `createDotnetProcessKind(options.dotnet, createPhpProcessKind(options.php, createPythonProcessKind(options.python)))`.
 *
 * Until node/protocol.ts lists `'dotnet'` in `WorkerKind` and `dotnet` in
 * `StartMessage`, the kind and the start options are cast at this seam.
 */
import { findExecutable, shebangCommand } from '@seanhogg/builderforce-webcontainers-core';
import { NODE_ONLY, type ProcessKindPolicy, type ProcessRoute } from '../../node/processKinds.js';
import type { WorkerKind } from '../../node/protocol.js';
import { DOTNET_COMMAND_PATTERN, isDotnetCommand } from './dotnetCommand.js';
import { DOTNET_WORKER_KIND, type DotnetStartOptions } from './dotnetStartOptions.js';

/** Host-only settings for .NET processes: a program's environment can change none of them. */
export type DotnetHostOptions = DotnetStartOptions;

/** The .NET kind as the process protocol's `WorkerKind`. */
export const DOTNET_KIND = DOTNET_WORKER_KIND as unknown as WorkerKind;

const unionPattern = (...patterns: Array<string | undefined>) => {
  const present = patterns.filter((pattern): pattern is string => !!pattern);
  return present.length ? present.map((pattern) => `(?:${pattern})`).join('|') : undefined;
};

export function createDotnetProcessKind(options: DotnetHostOptions = {}, next: ProcessKindPolicy = NODE_ONLY): ProcessKindPolicy {
  return {
    foreignCommands: unionPattern(DOTNET_COMMAND_PATTERN, next.foreignCommands),
    route(command, args, context): ProcessRoute {
      if (isDotnetCommand(command)) return { kind: DOTNET_KIND, command, args };
      // A file-based program run by path: its shebang may name dotnet.
      const file = command.includes('/') ? findExecutable(context.fs, command, context.cwd, context.env) : undefined;
      const interpreter = file && shebangCommand(context.fs, file);
      if (file && interpreter && isDotnetCommand(interpreter)) return { kind: DOTNET_KIND, command: interpreter, args: [file, ...args] };
      return next.route(command, args, context);
    },
    startOptions(kind) {
      if (kind !== DOTNET_KIND) return next.startOptions(kind);
      return { dotnet: { ...options } } as unknown as ReturnType<ProcessKindPolicy['startOptions']>;
    },
    receive: (kind, message) => kind !== DOTNET_KIND && next.receive(kind, message),
  };
}
