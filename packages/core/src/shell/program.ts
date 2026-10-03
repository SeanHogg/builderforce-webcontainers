/**
 * The `jsh` program: `jsh -c "…"`, `jsh script.sh`, a script on stdin, or —
 * attached to a terminal — the interactive shell. Interactively the shell owns
 * the keyboard (raw mode) while it edits a line, and hands it to the running
 * job otherwise: straight through to a terminal-attached child (which has its
 * own line discipline), or cooked by the shell for everything else.
 */
import type { Program, ProgramContext } from '../system/types.js';
import { InputQueue, LineDiscipline } from '../system/terminal.js';
import { join } from '../paths.js';
import { binDirectories } from '../system/commands.js';
import { parse, ShellSyntaxError } from './parse.js';
import { Shell, type JobInput, type ShellCommand, type ShellIO } from './exec.js';
import { LineEditor } from './lineEditor.js';
import { BUILTINS, COREUTILS, SYSTEM_PROGRAMS } from './builtins.js';
import { npmCommand, npxCommand } from './npm.js';
import { glob } from './expand.js';

export const SHELL_COMMANDS: Record<string, ShellCommand> = { npm: npmCommand, npx: npxCommand };

function createShell(ctx: ProgramContext, positional: string[] = []): Shell {
  return new Shell({
    system: ctx.system,
    cwd: ctx.cwd,
    env: { ...ctx.env, SHELL: '/bin/jsh' },
    positional,
    terminalSize: () => (ctx.io.terminal ? { cols: ctx.io.terminal.cols, rows: ctx.io.terminal.rows } : undefined),
    commands: SHELL_COMMANDS,
  });
}

/**
 * The stdin a non-interactive run hands its commands. On a terminal the shell
 * takes raw input so a terminal-attached child (node, a REPL) gets keystrokes
 * once — its own line discipline cooks them — while everything else gets lines
 * cooked here, exactly once.
 */
function stdinJob(ctx: ProgramContext, controller?: AbortController): { input: JobInput; stop(): void } {
  const queue = new InputQueue();
  const terminal = ctx.io.terminal;
  if (!terminal) {
    const stop = ctx.io.onStdin((chunk) => queue.push(chunk));
    return { input: { queue }, stop };
  }
  terminal.setRawMode(true);
  let rawSink: ((data: string) => void) | undefined;
  const discipline = new LineDiscipline({
    echo: (t) => ctx.io.stdout(t),
    deliver: (chunk) => queue.push(chunk),
    signal: (name) => controller?.abort(name),
  });
  const stop = ctx.io.onStdin((chunk) => {
    if (chunk === null) queue.push(null);
    else if (rawSink) rawSink(chunk);
    else discipline.input(chunk);
  });
  return {
    input: { queue, setRawSink: (sink) => void (rawSink = sink) },
    stop() {
      stop();
      terminal.setRawMode(false);
    },
  };
}

/** Run with a signal that both the program's kill and a cooked Ctrl-C abort. */
async function runOnce(ctx: ProgramContext, shell: Shell, source: string): Promise<number> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort);
  const { input, stop } = stdinJob(ctx, controller);
  try {
    return await shell.exec(source, text(ctx), input, controller.signal);
  } finally {
    stop();
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

const text = (ctx: ProgramContext): ShellIO => ({
  stdout: (t) => ctx.io.stdout(t),
  stderr: (t) => ctx.io.stderr(t),
  isTerminal: !!ctx.io.terminal,
});

function displayCwd(cwd: string, home: string | undefined): string {
  if (home && (cwd === home || cwd.startsWith(home + '/'))) return '~' + cwd.slice(home.length);
  return cwd;
}

function completer(shell: Shell) {
  return (before: string, word: string): string[] => {
    const isCommand = !/\S\s/.test(before.trimStart()) && !word.includes('/');
    const fs = shell.system.fs;
    const dirPart = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
    const files = glob(fs, shell.cwd, `${dirPart}*`).filter((f) => f.slice(dirPart.length).startsWith(word.slice(dirPart.length)) || !dirPart)
      .filter((f) => f.startsWith(word))
      .map((f) => (fs.isDirectory(f.startsWith('/') ? f : join(shell.cwd, f)) ? f + '/' : f));
    if (!isCommand) return files.sort();
    const commands = new Set([...Object.keys(BUILTINS), ...Object.keys(COREUTILS), ...SYSTEM_PROGRAMS]);
    for (const dir of binDirectories(shell.cwd)) for (const name of fs.readdir(dir)) commands.add(name);
    return [...[...commands].filter((c) => c.startsWith(word)).sort(), ...files.filter((f) => f.endsWith('/'))];
  };
}

async function interactive(ctx: ProgramContext): Promise<number> {
  const terminal = ctx.io.terminal!;
  const shell = createShell(ctx);
  const io = text(ctx);
  terminal.setRawMode(true);
  const editor = new LineEditor({ write: (t) => ctx.io.stdout(t), history: shell.history, complete: completer(shell) });
  const prompt = () => `\x1b[1;36m${displayCwd(shell.cwd, shell.env.HOME)}\x1b[0m \x1b[1;32m$\x1b[0m `;

  let job: { controller: AbortController; input: JobInput; discipline: LineDiscipline; rawSink?: (data: string) => void } | undefined;
  let pending = '';
  let typeahead = '';
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => (finish = resolve));

  const runLine = async (line: string) => {
    const queue = new InputQueue();
    const controller = new AbortController();
    const discipline = new LineDiscipline({
      echo: (t) => ctx.io.stdout(t),
      deliver: (chunk) => queue.push(chunk),
      signal: (name) => controller.abort(name),
    });
    const current: NonNullable<typeof job> = { controller, input: { queue }, discipline };
    current.input.setRawSink = (sink) => void (current.rawSink = sink);
    job = current;
    try {
      await shell.exec(line, io, current.input, controller.signal);
    } catch (error) {
      ctx.io.stderr(`jsh: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    job = undefined;
    if (shell.exitRequested !== undefined) return finish(shell.exitRequested);
    editor.begin(prompt());
    if (typeahead) {
      const rest = typeahead;
      typeahead = '';
      onInput(rest);
    }
  };

  const onInput = (data: string) => {
    if (job) {
      if (job.rawSink) job.rawSink(data);
      else job.discipline.input(data);
      return;
    }
    let rest = data;
    while (rest && !job) {
      const { event, rest: remaining } = editor.feed(rest);
      rest = remaining;
      if (!event) break;
      if (event.type === 'eof') {
        ctx.io.stdout('exit\r\n');
        return finish(shell.lastStatus);
      }
      if (event.type === 'interrupt') {
        pending = '';
        shell.lastStatus = 130;
        editor.begin(prompt());
        continue;
      }
      const source = pending ? `${pending}\n${event.line}` : event.line;
      try {
        parse(source);
      } catch (error) {
        if (error instanceof ShellSyntaxError && error.incomplete) {
          pending = source;
          editor.begin('> ');
          continue;
        }
      }
      pending = '';
      if (!source.trim()) {
        editor.begin(prompt());
        continue;
      }
      typeahead = rest;
      rest = '';
      void runLine(source);
    }
  };

  const stopInput = ctx.io.onStdin((chunk) => (chunk === null ? finish(shell.lastStatus) : onInput(chunk)));
  const onAbort = () => {
    job?.controller.abort('SIGHUP');
    finish(129);
  };
  ctx.signal.addEventListener('abort', onAbort);
  editor.begin(prompt());
  const code = await done;
  stopInput();
  ctx.signal.removeEventListener('abort', onAbort);
  terminal.setRawMode(false);
  return code;
}

export const shellProgram: Program = async (ctx) => {
  const args = ctx.args.filter((a) => a !== '-l' && a !== '--login' && a !== '-i');
  if (args[0] === '-c') return runOnce(ctx, createShell(ctx, args.slice(2)), args[1] ?? '');
  if (args[0]) {
    const path = args[0].startsWith('/') ? args[0] : join(ctx.cwd, args[0]);
    const source = ctx.system.fs.readText(path);
    if (source === undefined) {
      ctx.io.stderr(`jsh: ${args[0]}: No such file or directory\n`);
      return 127;
    }
    return runOnce(ctx, createShell(ctx, args.slice(1)), source.replace(/^#!.*\n/, ''));
  }
  if (ctx.io.terminal) return interactive(ctx);
  // No terminal, no script: read commands from stdin.
  const { input, stop } = stdinJob(ctx);
  const source = await input.queue.readAll();
  stop();
  const shell = createShell(ctx);
  const empty = new InputQueue();
  empty.push(null);
  return shell.exec(source, text(ctx), { queue: empty }, ctx.signal);
};
