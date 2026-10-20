/**
 * Builtins that change or inspect the shell itself (cd, export, exit…), plus
 * the command tables the executor dispatches on.
 */

import { findExecutable } from '../system/commands.js';
import type { CommandContext, Command } from './context.js';
import { resolvePath } from './context.js';
import { cat, cp, ls, mkdir, mv, pwd, rm, touch } from './fileCommands.js';
import { basename, clear, dirname, echo, env, falseCommand, grep, head, printf, sleep, tail, trueCommand, wc } from './textCommands.js';
import { bracket, test } from './testCommand.js';
import { readLine } from './lineReader.js';
import type { Flow } from './compound.js';
import { setBuiltin, type ShellSettings } from './options.js';

/** A command started with `&`. */
export interface BackgroundJob {
  id: number;
  done: Promise<number>;
}

/** The slice of the shell a builtin may change. */
export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  history: string[];
  lastStatus: number;
  /** Set by `exit`: the shell stops after the current command. */
  exitRequested?: number;
  /** Set by `break`, `continue` and `return`; the loop or function it targets clears it. */
  flow?: Flow;
  /** `$1…`, `$@`; a function call swaps them for its arguments. */
  positional: string[];
  /** `set -o` options (pipefail). */
  readonly settings: ShellSettings;
  readonly functions: ReadonlyMap<string, unknown>;
  readonly jobs: ReadonlyMap<number, BackgroundJob>;
  /** One frame per running function (for `local`). */
  readonly localFrames: Array<Map<string, string | undefined>>;
  /** Run a script in this shell (for `source`). */
  run(source: string): Promise<number>;
}

export type Builtin = (ctx: CommandContext, shell: ShellState) => Promise<number>;

/** Coreutils: plain commands, also spawnable as standalone programs. */
export const COREUTILS: Record<string, Command> = {
  ls, cat, mkdir, rm, cp, mv, touch, pwd, echo, printf, head, tail, grep, wc, env, clear, sleep, basename, dirname, test,
  '[': bracket,
  true: trueCommand,
  false: falseCommand,
};

/** Programs the runtime provides besides coreutils (reported by `which`/`type`). */
export const SYSTEM_PROGRAMS = ['node', 'npm', 'npx', 'pnpm', 'yarn', 'bfsh', 'sh', 'bash'];

const HELP = `bfsh — BuilderForce WebContainers shell

  Builtins:  cd, pwd, export, unset, exit, source, history, type, which, help,
             read, local, shift, return, break, continue, jobs, wait,
             set -o|+o pipefail (on by default), set -- args
  Files:     ls [-la], cat, mkdir [-p], rm [-rf], cp [-r], mv, touch, test / [ … ]
  Text:      echo, printf, head, tail, grep, wc, env, clear, sleep, basename, dirname
  Node:      node <file>, npm install|ci|run|start|test, npx <bin>, pnpm, yarn
  Syntax:    'quotes' "\$VARS" a && b || c; a | b > out.txt >> log 2>&1 2> err; FOO=bar cmd; $(cmd); *.js
             if …; then …; elif …; else …; fi   while|until …; do …; done   for x in …; do …; done
             case $x in a|b) …;; *) …;; esac   name() { …; }   { …; }   ( … )   cat <<EOF … EOF

`;

export const BUILTINS: Record<string, Builtin> = {
  set: setBuiltin,
  async cd(ctx, shell) {
    const home = shell.env.HOME && ctx.fs.isDirectory(shell.env.HOME) ? shell.env.HOME : '/';
    const target = ctx.args[0] === '-' ? shell.env.OLDPWD ?? shell.cwd : ctx.args[0] ?? home;
    const path = resolvePath(ctx, target);
    if (!ctx.fs.isDirectory(path)) {
      ctx.io.stderr(`cd: ${ctx.fs.isFile(path) ? 'not a directory' : 'no such file or directory'}: ${target}\n`);
      return 1;
    }
    shell.env.OLDPWD = shell.cwd;
    shell.cwd = path;
    shell.env.PWD = path;
    if (ctx.args[0] === '-') ctx.io.stdout(path + '\n');
    return 0;
  },
  async export(ctx, shell) {
    if (!ctx.args.length) {
      ctx.io.stdout(Object.entries(shell.env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n') + '\n');
      return 0;
    }
    for (const arg of ctx.args) {
      const eq = arg.indexOf('=');
      if (eq > 0) shell.env[arg.slice(0, eq)] = arg.slice(eq + 1);
      else if (!(arg in shell.env)) shell.env[arg] = '';
    }
    return 0;
  },
  async unset(ctx, shell) {
    for (const name of ctx.args) delete shell.env[name];
    return 0;
  },
  async exit(ctx, shell) {
    const code = ctx.args[0] === undefined ? shell.lastStatus : Number(ctx.args[0]);
    shell.exitRequested = Number.isFinite(code) ? code & 255 : 2;
    return shell.exitRequested;
  },
  async source(ctx, shell) {
    const file = ctx.args[0];
    if (!file) {
      ctx.io.stderr('source: filename argument required\n');
      return 2;
    }
    const text = ctx.fs.readText(resolvePath(ctx, file));
    if (text === undefined) {
      ctx.io.stderr(`source: ${file}: No such file or directory\n`);
      return 1;
    }
    return shell.run(text);
  },
  async history(ctx, shell) {
    ctx.io.stdout(shell.history.map((line, i) => `${String(i + 1).padStart(5)}  ${line}`).join('\n') + (shell.history.length ? '\n' : ''));
    return 0;
  },
  async help(ctx) {
    ctx.io.stdout(HELP);
    return 0;
  },
  async which(ctx) {
    let status = 0;
    for (const name of ctx.args.filter((a) => !a.startsWith('-'))) {
      if (name in COREUTILS || SYSTEM_PROGRAMS.includes(name)) ctx.io.stdout(`/usr/local/bin/${name}\n`);
      else if (name in BUILTINS) ctx.io.stdout(`${name}: shell built-in command\n`);
      else {
        const file = findExecutable(ctx.fs, name, ctx.cwd, ctx.env);
        if (file) ctx.io.stdout(file + '\n');
        else {
          ctx.io.stderr(`${name} not found\n`);
          status = 1;
        }
      }
    }
    return status;
  },
  async type(ctx, shell) {
    let status = 0;
    for (const name of ctx.args) {
      if (shell.functions.has(name)) ctx.io.stdout(`${name} is a function\n`);
      else if (name in BUILTINS) ctx.io.stdout(`${name} is a shell builtin\n`);
      else if (name in COREUTILS || SYSTEM_PROGRAMS.includes(name)) ctx.io.stdout(`${name} is /usr/local/bin/${name}\n`);
      else {
        const file = findExecutable(ctx.fs, name, ctx.cwd, ctx.env);
        if (file) ctx.io.stdout(`${name} is ${file}\n`);
        else {
          ctx.io.stderr(`type: ${name}: not found\n`);
          status = 1;
        }
      }
    }
    return status;
  },
  async break(ctx, shell) {
    return loopControl(ctx, shell, 'break');
  },
  async continue(ctx, shell) {
    return loopControl(ctx, shell, 'continue');
  },
  async return(ctx, shell) {
    if (!shell.localFrames.length) {
      ctx.io.stderr('return: can only `return\' from a function or sourced script\n');
      return 1;
    }
    const status = ctx.args[0] === undefined ? shell.lastStatus : Number(ctx.args[0]) & 255;
    shell.flow = { kind: 'return', status };
    return status;
  },
  async local(ctx, shell) {
    const frame = shell.localFrames[shell.localFrames.length - 1];
    if (!frame) {
      ctx.io.stderr('local: can only be used in a function\n');
      return 1;
    }
    for (const arg of ctx.args) {
      const eq = arg.indexOf('=');
      const name = eq > 0 ? arg.slice(0, eq) : arg;
      if (!frame.has(name)) frame.set(name, shell.env[name]);
      shell.env[name] = eq > 0 ? arg.slice(eq + 1) : '';
    }
    return 0;
  },
  async shift(ctx, shell) {
    const count = ctx.args[0] === undefined ? 1 : Number(ctx.args[0]);
    if (!Number.isInteger(count) || count < 0 || count > shell.positional.length) return 1;
    shell.positional = shell.positional.slice(count);
    return 0;
  },
  async read(ctx, shell) {
    const raw = ctx.args.includes('-r');
    const names = ctx.args.filter((a) => !a.startsWith('-'));
    let line = await readLine(ctx.io.stdin, ctx.signal);
    if (line === null) return 1;
    if (!raw) line = line.replace(/\\(.)/g, '$1');
    const targets = names.length ? names : ['REPLY'];
    const fields = names.length ? line.trim().split(/\s+/) : [line];
    targets.forEach((name, i) => {
      shell.env[name] = i === targets.length - 1 ? fields.slice(i).join(' ') : fields[i] ?? '';
    });
    return 0;
  },
  async jobs(ctx, shell) {
    for (const job of shell.jobs.values()) ctx.io.stdout(`[${job.id}]  Running\n`);
    return 0;
  },
  async wait(ctx, shell) {
    const ids = ctx.args.map((a) => Number(a.replace(/^%/, '')));
    const jobs = ids.length ? ids.map((id) => shell.jobs.get(id)).filter((j): j is BackgroundJob => !!j) : [...shell.jobs.values()];
    const statuses = await Promise.all(jobs.map((job) => job.done));
    return statuses.length ? statuses[statuses.length - 1]! : 0;
  },
};

function loopControl(ctx: CommandContext, shell: ShellState, kind: 'break' | 'continue'): number {
  const levels = ctx.args[0] === undefined ? 1 : Number(ctx.args[0]);
  if (!Number.isInteger(levels) || levels < 1) {
    ctx.io.stderr(`${kind}: ${ctx.args[0]}: loop count out of range\n`);
    return 1;
  }
  shell.flow = { kind, levels };
  return 0;
}
BUILTINS['.'] = BUILTINS.source!;
BUILTINS[':'] = async () => 0;

