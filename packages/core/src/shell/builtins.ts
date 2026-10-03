/**
 * Builtins that change or inspect the shell itself (cd, export, exit…), plus
 * the command tables the executor dispatches on.
 */

import { findExecutable } from '../system/commands.js';
import type { CommandContext, Command } from './context.js';
import { resolvePath } from './context.js';
import { cat, cp, ls, mkdir, mv, pwd, rm, touch } from './fileCommands.js';
import { basename, clear, dirname, echo, env, falseCommand, grep, head, printf, sleep, tail, trueCommand, wc } from './textCommands.js';

/** The slice of the shell a builtin may change. */
export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  history: string[];
  lastStatus: number;
  /** Set by `exit`: the shell stops after the current command. */
  exitRequested?: number;
  /** Run a script in this shell (for `source`). */
  run(source: string): Promise<number>;
}

export type Builtin = (ctx: CommandContext, shell: ShellState) => Promise<number>;

/** Coreutils: plain commands, also spawnable as standalone programs. */
export const COREUTILS: Record<string, Command> = {
  ls, cat, mkdir, rm, cp, mv, touch, pwd, echo, printf, head, tail, grep, wc, env, clear, sleep, basename, dirname,
  true: trueCommand,
  false: falseCommand,
};

/** Programs the runtime provides besides coreutils (reported by `which`/`type`). */
export const SYSTEM_PROGRAMS = ['node', 'npm', 'npx', 'jsh', 'sh', 'bash'];

const HELP = `jsh — BuilderForce WebContainers shell

  Builtins:  cd, pwd, export, unset, exit, source, history, type, which, help
  Files:     ls [-la], cat, mkdir [-p], rm [-rf], cp [-r], mv, touch
  Text:      echo, printf, head, tail, grep, wc, env, clear, sleep, basename, dirname
  Node:      node <file>, npm install|ci|run|start|test, npx <bin>
  Syntax:    'quotes' "\$VARS" a && b || c; a | b > out.txt >> log 2>&1 2> err; FOO=bar cmd; $(cmd); *.js

`;

export const BUILTINS: Record<string, Builtin> = {
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
  async type(ctx) {
    let status = 0;
    for (const name of ctx.args) {
      if (name in BUILTINS) ctx.io.stdout(`${name} is a shell builtin\n`);
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
  async set() {
    return 0; // options (-e, -x) are accepted and ignored
  },
};
BUILTINS['.'] = BUILTINS.source!;
BUILTINS[':'] = async () => 0;

