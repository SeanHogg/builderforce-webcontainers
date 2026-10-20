/**
 * The executor: runs a parsed script. Lists honour `&&`/`||`/`;`/`&`; pipeline
 * stages run concurrently, joined by in-memory pipes, and a pipeline's status is
 * the rightmost non-zero stage (pipefail, on by default; `set +o pipefail` gives
 * the POSIX last-stage status). A stage writing to a pipe whose reader is gone
 * stops with EPIPE (SIGPIPE's status, 141) instead of buffering forever. Redirects
 * (here-documents included) swap a stage's stdin/stdout/stderr. Compound
 * commands run through compound.ts. Dispatch order per simple command: shell
 * functions, builtins,
 * extra in-process commands (npm, npx), the dev-server handoff, coreutils, and
 * finally `system.spawn` (node, scripts on PATH, `.bin` entries) — which in the
 * browser is a separate Web Worker.
 */
import type { System } from '../system/types.js';
import { InputQueue, textChunks } from '../system/terminal.js';
import { SIGPIPE_STATUS, brokePipe, isBrokenPipe } from '../system/signals.js';
import type { Command as CommandNode, FunctionDefinition, Pipeline, Redirect, Script, SimpleCommand, Word } from './ast.js';
import { parse, ShellSyntaxError } from './parse.js';
import { expandWord, expandWords, type ExpandContext } from './expand.js';
import { BUILTINS, COREUTILS, type BackgroundJob, type ShellState } from './builtins.js';
import { resolvePath, type CommandContext } from './context.js';
import { devServerHandoff, runDevServerHandoff } from './devHandoff.js';
import { runCompound, type Flow, type ScriptRunner } from './compound.js';
import { DEFAULT_SHELL_SETTINGS, pipelineStatus, type ShellSettings } from './options.js';

export interface ShellIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** stdout is a terminal. */
  isTerminal: boolean;
}

/** A job's stdin: a queue, and (interactive) a raw keystroke tap for a terminal-attached child. */
export interface JobInput {
  queue: InputQueue;
  /** Route raw terminal input straight to `sink` (a child with its own line discipline), or back to the queue. */
  setRawSink?(sink: ((data: string) => void) | undefined): void;
}

/** In-process commands with access to the shell (npm runs scripts through it). */
export type ShellCommand = (ctx: CommandContext, shell: Shell, input: JobInput) => Promise<number>;

export interface ShellOptions {
  system: System;
  cwd: string;
  env: Record<string, string>;
  positional?: string[];
  /** The terminal size, when attached to one. */
  terminalSize?: () => { cols: number; rows: number } | undefined;
  commands?: Record<string, ShellCommand>;
  /** Functions inherited from a parent shell (subshells and `$(…)`). */
  functions?: Map<string, FunctionDefinition>;
  /**
   * Fail a pipeline when any stage fails (status: the rightmost non-zero).
   * Default true; false is POSIX (the last stage's status). Scripts switch it
   * with `set -o pipefail` / `set +o pipefail`.
   */
  pipefail?: boolean;
}

let nextShellPid = 500;

export class Shell implements ShellState, ScriptRunner {
  cwd: string;
  env: Record<string, string>;
  lastStatus = 0;
  history: string[] = [];
  exitRequested?: number;
  flow?: Flow;
  positional: string[];
  readonly functions: Map<string, FunctionDefinition>;
  readonly settings: ShellSettings;
  readonly jobs = new Map<number, BackgroundJob>();
  /** One frame per running function: names declared `local`, with the value to restore. */
  readonly localFrames: Array<Map<string, string | undefined>> = [];
  readonly pid = nextShellPid++;
  readonly system: System;
  private nextJob = 1;
  private current?: { io: ShellIO; input: JobInput; signal: AbortSignal };

  constructor(readonly options: ShellOptions) {
    this.system = options.system;
    this.cwd = options.cwd;
    this.env = { ...options.env, PWD: options.cwd };
    this.positional = [...(options.positional ?? [])];
    this.functions = new Map(options.functions);
    this.settings = { ...DEFAULT_SHELL_SETTINGS, pipefail: options.pipefail ?? DEFAULT_SHELL_SETTINGS.pipefail };
  }

  /** A child shell for `npm run` / subshells: same IO, its own cwd, environment and functions. */
  fork(overrides: { cwd?: string; env?: Record<string, string>; positional?: string[] }): Shell {
    return new Shell({ ...this.options, cwd: overrides.cwd ?? this.cwd, env: { ...this.env, ...overrides.env }, positional: overrides.positional ?? this.positional, functions: this.functions, pipefail: this.settings.pipefail });
  }

  subshell(): Shell {
    return this.fork({});
  }

  /** Parse and run `source`. Syntax errors print and return 2. */
  async exec(source: string, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
    let script: Script;
    try {
      script = parse(source);
    } catch (error) {
      if (!(error instanceof ShellSyntaxError)) throw error;
      io.stderr(`bfsh: ${error.message}\n`);
      this.lastStatus = 2;
      return 2;
    }
    const previous = this.current;
    this.current = { io, input, signal };
    try {
      await this.runScript(script, io, input, signal);
    } finally {
      this.current = previous;
      // A `break`/`continue` outside any loop (or `return` outside a function) must not stop later lines.
      if (!this.localFrames.length) this.flow = undefined;
    }
    if (signal.aborted && this.lastStatus === 0) this.lastStatus = 130;
    return this.exitRequested ?? this.lastStatus;
  }

  /** `source` and friends: run in this shell with the current job's IO. */
  run(source: string): Promise<number> {
    const job = this.current;
    if (!job) throw new Error('Shell.run outside a job');
    return this.exec(source, job.io, job.input, job.signal);
  }

  async runScript(script: Script, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
    for (const list of script) {
      if (this.exitRequested !== undefined || signal.aborted || this.flow) break;
      const run = async () => {
        let status = await this.runPipeline(list.first, io, input, signal);
        for (const { op, pipeline } of list.rest) {
          if (this.exitRequested !== undefined || signal.aborted || this.flow) break;
          if ((op === '&&') === (status === 0)) status = await this.runPipeline(pipeline, io, input, signal);
        }
        return status;
      };
      if (list.background) {
        const id = this.nextJob++;
        const done = run();
        this.jobs.set(id, { id, done });
        void done.finally(() => this.jobs.delete(id));
        this.lastStatus = 0;
      } else this.lastStatus = await run();
    }
    return this.lastStatus;
  }

  expandWords(words: Word[], io: ShellIO, signal: AbortSignal): Promise<string[]> {
    return expandWords(words, this.expandContext(io, signal));
  }

  async expandText(word: Word, io: ShellIO, signal: AbortSignal): Promise<string> {
    return (await expandWord(word, this.expandContext(io, signal), { split: false, glob: false })).join('');
  }

  setVar(name: string, value: string): void {
    this.env[name] = value;
  }

  private expandContext(io: ShellIO, signal: AbortSignal): ExpandContext {
    return {
      fs: this.system.fs,
      cwd: this.cwd,
      get: (name) => this.env[name],
      set: (name, value) => void (this.env[name] = value),
      positional: this.positional,
      lastStatus: this.lastStatus,
      pid: this.pid,
      substitute: async (source) => {
        let out = '';
        const sub = this.fork({});
        await sub.exec(source, { stdout: (t) => (out += t), stderr: io.stderr, isTerminal: false }, { queue: emptyInput() }, signal);
        return out;
      },
    };
  }

  private async runPipeline(pipeline: Pipeline, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
    const count = pipeline.commands.length;
    const pipes = Array.from({ length: count - 1 }, () => new InputQueue());
    // Every stage settles before the pipeline does: none is left running detached.
    const settled = await Promise.allSettled(
      pipeline.commands.map(async (command, i) => {
        const stdin: JobInput = i === 0 ? input : { queue: pipes[i - 1]! };
        const stdout = i === count - 1 ? io.stdout : (text: string) => pipes[i]!.push(text);
        const stageIO: ShellIO = { stdout, stderr: io.stderr, isTerminal: io.isTerminal && i === count - 1 };
        try {
          return await this.runCommand(command, stageIO, stdin, signal, count === 1);
        } catch (error) {
          // Its own pipe broke (the reader exited): SIGPIPE ends the stage. An enclosing
          // pipeline's pipe is not its to absorb: that travels on, ending loops on the way.
          if (i < count - 1 && brokePipe(error, pipes[i]!)) return SIGPIPE_STATUS;
          throw error;
        } finally {
          if (i < count - 1) pipes[i]!.push(null);
          if (i > 0) pipes[i - 1]!.closeReader(); // its reader is gone: the writer upstream gets EPIPE
        }
      }),
    );
    const failed = settled.find((stage): stage is PromiseRejectedResult => stage.status === 'rejected');
    if (failed) throw failed.reason;
    const statuses = settled.map((stage) => (stage as PromiseFulfilledResult<number>).value);
    // pipefail (the default): any non-zero stage fails the pipeline, the status the
    // rightmost non-zero, so `build 2>&1 | tail` reports the build rather than tail's 0.
    // A one-stage pipeline (a non-pipeline command) is the same either way.
    const status = pipelineStatus(statuses, this.settings);
    return pipeline.negate ? (status === 0 ? 1 : 0) : status;
  }

  private async runCommand(node: CommandNode, io: ShellIO, input: JobInput, signal: AbortSignal, alone: boolean): Promise<number> {
    if (node.type === 'function') {
      this.functions.set(node.name, node);
      return 0;
    }
    if (node.type === 'simple') return this.runSimple(node, io, input, signal, alone);
    const redirected = await this.applyRedirects(node.redirects, io, input, signal);
    if (typeof redirected === 'number') return redirected;
    try {
      return await runCompound(node, this, redirected.io, redirected.input, signal);
    } finally {
      redirected.flush();
    }
  }

  private async runSimple(node: SimpleCommand, io: ShellIO, input: JobInput, signal: AbortSignal, alone: boolean): Promise<number> {
    const ectx = this.expandContext(io, signal);
    const argv = await expandWords(node.words, ectx);
    const assigned: Record<string, string> = {};
    for (const { name, value } of node.assignments) assigned[name] = (await expandWord(value, ectx, { split: false, glob: false })).join('');
    if (!argv.length) {
      Object.assign(this.env, assigned);
      return 0;
    }
    const redirected = await this.applyRedirects(node.redirects, io, input, signal);
    if (typeof redirected === 'number') return redirected;
    try {
      return await this.dispatch(argv, assigned, redirected.io, redirected.input, signal, alone && redirected.io.isTerminal);
    } finally {
      redirected.flush();
    }
  }

  /** Apply redirects; returns the new IO, or an exit status when a redirect fails. */
  private async applyRedirects(redirects: Redirect[], io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number | { io: ShellIO; input: JobInput; flush(): void }> {
    let { stdout, stderr, isTerminal } = io;
    let stdin = input;
    const flushes: Array<() => void> = [];
    const fromText = (text: string): JobInput => {
      const queue = new InputQueue();
      queue.push(text);
      queue.push(null);
      return { queue };
    };
    for (const redirect of redirects) {
      if (redirect.op === '2>&1') {
        stderr = stdout;
        continue;
      }
      if (redirect.op === '>&2') {
        stdout = stderr;
        continue;
      }
      if (redirect.heredoc) {
        const text = await this.expandText(redirect.heredoc.body, io, signal);
        stdin = fromText(text);
        continue;
      }
      const target = (await expandWord(redirect.target!, this.expandContext(io, signal))).join(' ');
      const path = resolvePath(this, target);
      if (redirect.op === '<') {
        const text = this.system.fs.readText(path);
        if (text === undefined) {
          io.stderr(`bfsh: ${target}: No such file or directory\n`);
          return 1;
        }
        stdin = fromText(text);
        continue;
      }
      if (this.system.fs.isDirectory(path)) {
        io.stderr(`bfsh: ${target}: Is a directory\n`);
        return 1;
      }
      const append = redirect.op === '>>' || redirect.op === '2>>';
      let content = append ? this.system.fs.readText(path) ?? '' : '';
      this.system.fs.writeFile(path, content);
      const sink = (text: string) => void (content += text);
      flushes.push(() => this.system.fs.writeFile(path, content));
      if (redirect.op === '2>' || redirect.op === '2>>') stderr = sink;
      else if (redirect.op === '&>') stdout = stderr = sink;
      else {
        stdout = sink;
        isTerminal = false;
      }
    }
    return { io: { stdout, stderr, isTerminal }, input: stdin, flush: () => flushes.forEach((flush) => flush()) };
  }

  private async dispatch(argv: string[], assigned: Record<string, string>, io: ShellIO, input: JobInput, signal: AbortSignal, attachTerminal: boolean): Promise<number> {
    const [name, ...args] = argv as [string, ...string[]];
    const fn = this.functions.get(name);
    if (fn) return this.callFunction(fn, args, io, input, signal);
    const env = { ...this.env, ...assigned };
    const ctx: CommandContext = {
      args,
      name,
      cwd: this.cwd,
      env,
      fs: this.system.fs,
      system: this.system,
      io: { stdout: io.stdout, stderr: io.stderr, stdin: input.queue, isTerminal: io.isTerminal },
      signal,
    };
    const builtin = BUILTINS[name];
    if (builtin) return builtin(ctx, this);
    const command = this.options.commands?.[name];
    if (command) return command(ctx, this, input);
    const handoff = devServerHandoff(ctx, argv);
    if (handoff) return runDevServerHandoff(ctx, argv, handoff);
    const coreutil = COREUTILS[name];
    if (coreutil) return coreutil(ctx);
    return this.spawnExternal(name, args, env, io, input, signal, attachTerminal);
  }

  /** A shell function: its own positional parameters and `local` frame; `return` ends it. */
  private async callFunction(fn: FunctionDefinition, args: string[], io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
    const savedPositional = this.positional;
    this.positional = args;
    const frame = new Map<string, string | undefined>();
    this.localFrames.push(frame);
    try {
      let status = await runCompound(fn.body, this, io, input, signal);
      if (this.flow?.kind === 'return') {
        status = this.flow.status;
        this.flow = undefined;
      }
      return status;
    } finally {
      this.localFrames.pop();
      for (const [name, value] of frame) {
        if (value === undefined) delete this.env[name];
        else this.env[name] = value;
      }
      this.positional = savedPositional;
    }
  }

  private async spawnExternal(name: string, args: string[], env: Record<string, string>, io: ShellIO, input: JobInput, signal: AbortSignal, attachTerminal: boolean): Promise<number> {
    const size = attachTerminal ? this.options.terminalSize?.() : undefined;
    let child;
    try {
      child = this.system.spawn(name, args, { cwd: this.cwd, env, terminal: size });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      io.stderr(`bfsh: command not found: ${name}\n`);
      return 127;
    }
    // The shell's own IO is text; a child's bytes are decoded as they enter it. Writing into
    // a pipe whose reader has exited kills the child with SIGPIPE (its timers stop with it),
    // then raises the break here, so the stage owning the pipe ends — a loop around it too.
    let brokenPipe: unknown;
    const relay = (write: (text: string) => void) => (text: string | null) => {
      if (text === null || brokenPipe !== undefined) return;
      try {
        write(text);
      } catch (error) {
        if (!isBrokenPipe(error)) throw error;
        brokenPipe = error;
        child.kill('SIGPIPE');
      }
    };
    child.onStdout(textChunks(relay(io.stdout)));
    child.onStderr(textChunks(relay(io.stderr)));
    let stop: (() => void) | undefined;
    if (size && input.setRawSink) input.setRawSink((data) => child.write(data));
    else stop = input.queue.subscribe((chunk) => (chunk === null ? child.closeStdin() : child.write(chunk)));
    const onAbort = () => child.kill(typeof signal.reason === 'string' ? signal.reason : 'SIGINT');
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort);
    try {
      const code = await child.exit;
      if (brokenPipe !== undefined) throw brokenPipe;
      return code;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (size && input.setRawSink) input.setRawSink(undefined);
      stop?.();
    }
  }
}

function emptyInput(): InputQueue {
  const queue = new InputQueue();
  queue.push(null);
  return queue;
}
