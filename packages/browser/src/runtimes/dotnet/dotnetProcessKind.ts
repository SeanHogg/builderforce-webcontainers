/**
 * The .NET runtime's process-kind policy for the process host
 * (node/processKinds.ts): `dotnet` commands — and file-based programs whose
 * shebang names dotnet (`#!/usr/bin/env dotnet`, run as `./app.cs`) — run in
 * a .NET process Worker, whose start message carries the host's instructions
 * (where the runtime bundle is served). Every other command goes to `next`, so
 * one host chains the runtimes:
 * `createDotnetProcessKind(options.dotnet, createPhpProcessKind(options.php, createPythonProcessKind(options.python)))`.
 */
import { NODE_ONLY, unionCommandPatterns, type ProcessKindPolicy, type ProcessRoute } from '../../node/processKinds.js';
import { shebangRoute } from '../shebangRoute.js';
import { DOTNET_COMMAND_PATTERN, isDotnetCommand } from './dotnetCommand.js';
import { DOTNET_KIND, type DotnetStartOptions } from './dotnetStartOptions.js';

export { DOTNET_KIND };

/** Host-only settings for .NET processes: a program's environment can change none of them. */
export type DotnetHostOptions = DotnetStartOptions;

export function createDotnetProcessKind(options: DotnetHostOptions = {}, next: ProcessKindPolicy = NODE_ONLY): ProcessKindPolicy {
  return {
    foreignCommands: unionCommandPatterns(DOTNET_COMMAND_PATTERN, next.foreignCommands),
    route(command, args, context): ProcessRoute {
      if (isDotnetCommand(command)) return { kind: DOTNET_KIND, command, args };
      // A file-based program run by path: its shebang may name dotnet.
      const program = shebangRoute(command, args, context, isDotnetCommand);
      return program ? { kind: DOTNET_KIND, ...program } : next.route(command, args, context);
    },
    startOptions: (kind, context) => (kind === DOTNET_KIND ? { dotnet: { ...options } } : next.startOptions(kind, context)),
    receive: (kind, message, context) => kind !== DOTNET_KIND && next.receive(kind, message, context),
  };
}
