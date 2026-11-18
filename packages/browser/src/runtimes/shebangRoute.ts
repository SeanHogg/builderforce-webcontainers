/**
 * A script run by path whose shebang names an interpreter (`./manage.py` with
 * `#!/usr/bin/env python3`, `./artisan` with `#!/usr/bin/env php`, `./app.cs`
 * with `#!/usr/bin/env dotnet`): the interpreter's command line for it, for the
 * process-kind policies of the Python, PHP and .NET runtimes.
 *
 * The policies are chained (.NET → PHP → Python → Node), each asking about the
 * same spawn: the script is found and its first line read once per spawn — the
 * host builds one route context per spawn, and the lookup is kept against it.
 */
import { findExecutable, shebangCommand, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';

type RouteContext = { fs: VirtualFileSystem; cwd: string; env: Record<string, string> };

/** The script `command` names and its shebang's interpreter, per route context (one per spawn). */
const looked = new WeakMap<RouteContext, { command: string; file?: string; interpreter?: string }>();

function scriptOf(command: string, context: RouteContext): { file?: string; interpreter?: string } {
  const known = looked.get(context);
  if (known?.command === command) return known;
  const file = command.includes('/') ? findExecutable(context.fs, command, context.cwd, context.env) : undefined;
  const interpreter = file ? shebangCommand(context.fs, file) : undefined;
  const found = { command, file, interpreter };
  looked.set(context, found);
  return found;
}

/** `command args…` as `interpreter script args…` when `command` is a script whose shebang `isInterpreter` accepts; else undefined. */
export function shebangRoute(command: string, args: readonly string[], context: RouteContext, isInterpreter: (command: string) => boolean): { command: string; args: string[] } | undefined {
  const { file, interpreter } = scriptOf(command, context);
  return file && interpreter && isInterpreter(interpreter) ? { command: interpreter, args: [file, ...args] } : undefined;
}
