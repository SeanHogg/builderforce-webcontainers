/**
 * A script run by path whose shebang names an interpreter (`./manage.py` with
 * `#!/usr/bin/env python3`, `./artisan` with `#!/usr/bin/env php`): the
 * interpreter's command line for it, for the process-kind policies of the
 * Python and PHP runtimes.
 */
import { findExecutable, shebangCommand, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';

/** `command args…` as `interpreter script args…` when `command` is a script whose shebang `isInterpreter` accepts; else undefined. */
export function shebangRoute(command: string, args: readonly string[], context: { fs: VirtualFileSystem; cwd: string; env: Record<string, string> }, isInterpreter: (command: string) => boolean): { command: string; args: string[] } | undefined {
  const file = command.includes('/') ? findExecutable(context.fs, command, context.cwd, context.env) : undefined;
  const interpreter = file && shebangCommand(context.fs, file);
  return file && interpreter && isInterpreter(interpreter) ? { command: interpreter, args: [file, ...args] } : undefined;
}
