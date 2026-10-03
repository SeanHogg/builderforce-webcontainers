/**
 * The executor: runs a parsed script. Lists honour `&&`/`||`/`;`/`&`; pipeline
 * stages run concurrently, joined by in-memory pipes; redirects swap a stage's
 * stdin/stdout/stderr for files. Dispatch order per command: shell builtins,
 * extra in-process commands (npm, npx), the dev-server handoff, coreutils, and
 * finally `system.spawn` (node, scripts on PATH, `.bin` entries) — which in the
 * browser is a separate Web Worker.
 */
import type { System } from '../system/types.js';
import { InputQueue } from '../system/terminal.js';
import { parse, ShellSyntaxError, type Command as CommandNode, type Pipeline, type Script } from './parse.js';
import { expandWord, expandWords, type ExpandContext } from './expand.js';
import { BUILTINS, COREUTILS, type ShellState } from './builtins.js';
import { resolvePath, type CommandContext } from './context.js';
import { matchDevServer, runDevServerHandoff } from './devHandoff.js';

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
}

let nextShellPid = 500;

export class Shell implements ShellState {
  cwd: string;
  env: Record<string, string>;
  lastStatus = 0;
  history: string[] = [];
  exitRequested?: number;
  readonly pid = nextShellPid++;
  readonly system: System;
  private readonly positional: string[];
  private current?: { io: ShellIO; input: JobInput; signal: AbortSignal };

  constructor(readonly options: ShellOptions) {
    this.system = options.system;
    this.cwd = options.cwd;
    this.env = { ...options.env, PWD: options.cwd };
    this.positional = options.positional ?? [];
  }

  /** A child shell for `npm run` / subshells: same IO, its own cwd and environment. */
  fork(overrides: { cwd?: string; env?: Record<string, string>; positional?: string[] }): Shell {
    return new Shell({ ...this.options, cwd: overrides.cwd ?? this.cwd, env: { ...this.env, ...overrides.env }, positional: overrides.positional });
  }

  /** Parse and run `source`. Syntax errors print and return 2. */
  async exec(source: string, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
    let script: Script;
    try {
      script = parse(source);
    } catch (error) {
      if (!(error instanceof ShellSyntaxError)) throw error;
      io.stderr(`jsh: ${error.message}\n`);
      this.lastStatus = 2;
      return 2;
    }
    const previous = this.current;
    this.current = { io, input, signal };
    try {
      for (const list of script) {
        if (this.exitRequested !== undefined || signal.aborted) break;
        const run = async () => {
          let status = await this.runPipeline(list.first, io, input, signal);
          for (const { op, pipeline } of list.rest) {
            if (this.exitRequested !== undefined || signal.aborted) break;
            if ((op === '&&') === (status === 0)) status = await this.runPipeline(pipeline, io, input, signal);
          }
          return status;
        };
        if (list.background) {
          void run();
          this.lastStatus = 0;
        } else this.lastStatus = await run();
      }
    } finally {
      this.current = previous;
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
    const statuses = await Promise.all(
      pipeline.commands.map(async (command, i) => {
        const stdin: JobInput = i === 0 ? input : { queue: pipes[i - 1]! };
        const stdout = i === count - 1 ? io.stdout : (text: string) => pipes[i]!.push(text);
        const stageIO: ShellIO = { stdout, stderr: io.stderr, isTerminal: io.isTerminal && i === count - 1 };
        try {
          return await this.runCommand(command, stageIO, stdin, signal, count === 1);
        } finally {
          if (i < count - 1) pipes[i]!.push(null);
        }
      }),
    );
    const status = statuses[statuses.length - 1]!;
    return pipeline.negate ? (status === 0 ? 1 : 0) : status;
  }

  private async runCommand(node: CommandNode, io: ShellIO, input: JobInput, signal: AbortSignal, alone: boolean): Promise<number> {
    const ectx = this.expandContext(io, signal);
    const argv = await expandWords(node.words, ectx);
    const assigned: Record<string, string> = {};
    for (const { name, value } of node.assignments) assigned[name] = (await expandWord(value, ectx, { split: false, glob: false })).join('');
    if (!argv.length) {
      Object.assign(this.env, assigned);
      return 0;
    }

    // Redirects.
    let stdout = io.stdout;
    let stderr = io.stderr;
    let stdin = input;
    let isTerminal = io.isTerminal;
    const flushes: Array<() => void> = [];
    for (const redirect of node.redirects) {
      if (redirect.op === '2>&1') {
        stderr = stdout;
        continue;
      }
      if (redirect.op === '>&2') {
        stdout = stderr;
        continue;
      }
      const target = (await expandWord(redirect.target!, ectx)).join(' ');
      const path = resolvePath(this, target);
      if (redirect.op === '<') {
        const text = this.system.fs.readText(path);
        if (text === undefined) {
          io.stderr(`jsh: ${target}: No such file or directory\n`);
          return 1;
        }
        const queue = new InputQueue();
        queue.push(text);
        queue.push(null);
        stdin = { queue };
        continue;
      }
      if (this.system.fs.isDirectory(path)) {
        io.stderr(`jsh: ${target}: Is a directory\n`);
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

    try {
      return await this.dispatch(argv, assigned, { stdout, stderr, isTerminal }, stdin, signal, alone && isTerminal);
    } finally {
      for (const flush of flushes) flush();
    }
  }

  private async dispatch(argv: string[], assigned: Record<string, string>, io: ShellIO, input: JobInput, signal: AbortSignal, attachTerminal: boolean): Promise<number> {
    const [name, ...args] = argv as [string, ...string[]];
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
    const handoff = matchDevServer(argv);
    if (handoff) return runDevServerHandoff(ctx, argv, handoff);
    const coreutil = COREUTILS[name];
    if (coreutil) return coreutil(ctx);
    return this.spawnExternal(name, args, env, io, input, signal, attachTerminal);
  }

  private async spawnExternal(name: string, args: string[], env: Record<string, string>, io: ShellIO, input: JobInput, signal: AbortSignal, attachTerminal: boolean): Promise<number> {
    const size = attachTerminal ? this.options.terminalSize?.() : undefined;
    let child;
    try {
      child = this.system.spawn(name, args, { cwd: this.cwd, env, terminal: size });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
      io.stderr(`jsh: command not found: ${name}\n`);
      return 127;
    }
    child.onStdout(io.stdout);
    child.onStderr(io.stderr);
    let stop: (() => void) | undefined;
    if (size && input.setRawSink) input.setRawSink((data) => child.write(data));
    else stop = input.queue.subscribe((chunk) => (chunk === null ? child.closeStdin() : child.write(chunk)));
    const onAbort = () => child.kill(typeof signal.reason === 'string' ? signal.reason : 'SIGINT');
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort);
    try {
      return await child.exit;
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
