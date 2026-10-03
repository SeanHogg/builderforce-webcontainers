/**
 * What a shell command runs with. Builtins get the shell's own state (to `cd`
 * and `export`); coreutils only need IO, cwd and the file system, which is why
 * they can also be spawned as standalone programs (`spawn('ls', ['-la'])`).
 */
import type { VirtualFileSystem } from '../vfs.js';
import type { Program, System } from '../system/types.js';
import { InputQueue } from '../system/terminal.js';
import { join, normalizePath } from '../paths.js';

export interface CommandIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdin: InputQueue;
  /** stdout is a terminal (colours, `clear`). */
  isTerminal: boolean;
}

export interface CommandContext {
  /** Arguments after the command name. */
  args: string[];
  /** The command name as typed (for messages). */
  name: string;
  cwd: string;
  env: Record<string, string>;
  fs: VirtualFileSystem;
  system: System;
  io: CommandIO;
  signal: AbortSignal;
}

export type Command = (ctx: CommandContext) => Promise<number>;

export function resolvePath(ctx: { cwd: string; env: Record<string, string> }, path: string): string {
  if (path === '~' || path.startsWith('~/')) return join(ctx.env.HOME ?? '/home/user', path.slice(1));
  return path.startsWith('/') ? normalizePath(path) : join(ctx.cwd, path);
}

/** Split `-abc` style flags from operands (`--` ends flags). */
export function parseFlags(args: string[], withValue: string[] = []): { flags: Set<string>; values: Record<string, string>; operands: string[] } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const [k, v] = arg.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) values[k] = v;
      else if (withValue.includes(k)) values[k] = args[++i] ?? '';
      else flags.add(k);
    } else if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      for (let j = 1; j < arg.length; j++) {
        const f = arg[j]!;
        if (withValue.includes(f)) {
          values[f] = arg.slice(j + 1) || args[++i] || '';
          break;
        }
        flags.add(f);
      }
    } else operands.push(arg);
  }
  return { flags, values, operands };
}

/** Run a coreutil as a standalone program (spawned directly rather than from the shell). */
export function asProgram(command: Command, name: string): Program {
  return async (ctx) => {
    const stdin = new InputQueue();
    const stop = ctx.io.onStdin((chunk) => stdin.push(chunk));
    try {
      return await command({
        args: ctx.args,
        name,
        cwd: ctx.cwd,
        env: ctx.env,
        fs: ctx.system.fs,
        system: ctx.system,
        io: { stdout: ctx.io.stdout, stderr: ctx.io.stderr, stdin, isTerminal: !!ctx.io.terminal },
        signal: ctx.signal,
      });
    } finally {
      stop();
    }
  };
}
