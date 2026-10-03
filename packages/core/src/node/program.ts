/**
 * The `node` command: CLI flags, the entry script (or `-e`/`-p`, or stdin), and
 * a small REPL when attached to a terminal with nothing to run.
 */
import type { Program, ProgramContext } from '../system/types.js';
import { join } from '../paths.js';
import { readBinLink } from '../installer/bins.js';
import { startNode, type NodeInstance } from './runtime.js';
import { NODE_VERSION } from './process.js';
import { inspect } from './inspect.js';
import { parseDotenv } from '../projectConfig.js';

interface NodeCli {
  entry?: string;
  args: string[];
  evaluate?: string;
  print?: boolean;
  preload: string[];
  envFiles: string[];
  version?: boolean;
  help?: boolean;
}

/** Flags that take the next argument as their value. */
const WITH_VALUE = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--title', '--env-file', '--stack-size']);

export function parseNodeArgs(argv: string[]): NodeCli {
  const cli: NodeCli = { args: [], preload: [], envFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      [cli.entry, ...cli.args] = argv.slice(i + 1);
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      cli.entry = arg;
      cli.args = argv.slice(i + 1);
      break;
    }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = () => inline ?? argv[++i] ?? '';
    if (flag === '-v' || flag === '--version') cli.version = true;
    else if (flag === '-h' || flag === '--help') cli.help = true;
    else if (flag === '-e' || flag === '--eval') cli.evaluate = value();
    else if (flag === '-p' || flag === '--print') {
      cli.evaluate = value();
      cli.print = true;
    } else if (flag === '-r' || flag === '--require' || flag === '--import') cli.preload.push(value());
    else if (flag === '--env-file') cli.envFiles.push(value());
    else if (WITH_VALUE.has(flag) && inline === undefined) i++;
    // everything else (--inspect, --no-warnings, --max-old-space-size=…) is accepted and ignored
  }
  if (cli.evaluate !== undefined && cli.entry !== undefined) {
    cli.args = [cli.entry, ...cli.args];
    cli.entry = undefined;
  }
  return cli;
}

const HELP = `Usage: node [options] [ script.js ] [arguments]
       node -e "script"    evaluate script
       node -p "expr"      evaluate and print
Options: -v, -r <module>, --env-file=<file>. Running in BuilderForce WebContainers.
`;

async function readAllStdin(ctx: ProgramContext): Promise<string> {
  let text = '';
  await new Promise<void>((resolve) => {
    const stop = ctx.io.onStdin((chunk) => {
      if (chunk === null) {
        stop();
        resolve();
      } else text += chunk;
    });
  });
  return text;
}

/** Evaluate REPL lines in one persistent sloppy-mode scope (`const`/`let` become `var` so they survive the line). */
function startRepl(instance: NodeInstance, ctx: ProgramContext): void {
  const { io } = ctx;
  const scope = evalInProcess(instance, ctx.cwd, '[repl]', `(function* () { let __r; while (true) { const __line = yield __r; try { __r = { value: eval(__line) }; } catch (e) { __r = { error: e }; } } })()`) as Generator<{ value?: unknown; error?: unknown } | undefined, never, string>;
  scope.next();
  const release = instance.hold();
  io.stdout(`Welcome to Node.js v${NODE_VERSION}.\nType ".exit" to leave.\n> `);
  const leave = () => {
    stop();
    release();
    instance.run(() => instance.process.exit(0));
  };
  const stop = io.onStdin((chunk) => {
    if (chunk === null) return leave();
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line === '.exit') return leave();
      const result = scope.next(line.replace(/^(const|let)\s/, 'var ')).value!;
      if ('error' in result) io.stdout(`Uncaught ${result.error instanceof Error ? result.error.stack ?? result.error.message : inspect(result.error)}\n`);
      else io.stdout(inspect(result.value, { colors: false }) + '\n');
    }
    io.stdout('> ');
  });
}

/** Evaluate `expression` inside the CommonJS wrapper, so it sees require, process, timers… of this process. */
function evalInProcess(instance: NodeInstance, cwd: string, name: string, expression: string): unknown {
  const filename = join(cwd, name);
  const module = new instance.modules.Module(filename);
  return module._compile(`return eval(${JSON.stringify(expression)});`, filename);
}

export const nodeProgram: Program = async (ctx) => {
  const cli = parseNodeArgs(ctx.args);
  if (cli.version) {
    ctx.io.stdout(`v${NODE_VERSION}\n`);
    return 0;
  }
  if (cli.help) {
    ctx.io.stdout(HELP);
    return 0;
  }
  const env = { ...ctx.env };
  for (const file of cli.envFiles) {
    const text = ctx.system.fs.readText(join(ctx.cwd, file));
    if (text === undefined) {
      ctx.io.stderr(`node: ${file}: not found\n`);
      return 9;
    }
    Object.assign(env, parseDotenv(text));
  }

  let entry: string | undefined;
  if (cli.entry !== undefined && cli.entry !== '-') {
    entry = cli.entry.startsWith('/') ? cli.entry : join(ctx.cwd, cli.entry);
    entry = readBinLink(ctx.system.fs, entry) ?? entry;
  }
  const source = cli.evaluate ?? (cli.entry === '-' || (!entry && !ctx.io.terminal) ? await readAllStdin(ctx) : undefined);
  const scriptPath = entry ?? (source !== undefined ? '[eval]' : undefined);
  const instance = await startNode({ system: ctx.system, io: ctx.io, cwd: ctx.cwd, env, installGlobals: ctx.system.ownsRealm, argv: scriptPath && scriptPath !== '[eval]' ? [scriptPath, ...cli.args] : cli.args });
  const onAbort = () => instance.kill(typeof ctx.signal.reason === 'string' ? ctx.signal.reason : 'SIGTERM');
  if (ctx.signal.aborted) onAbort();
  ctx.signal.addEventListener('abort', onAbort);
  const untrap = ctx.system.trapUncaught?.((error) => instance.reportUncaught(error));

  instance.run(() => {
    const require = instance.modules.createRequire(join(ctx.cwd, '[eval]'));
    for (const id of cli.preload) require(id.startsWith('.') ? join(ctx.cwd, id) : id);
    if (entry) {
      let resolved: string;
      try {
        resolved = instance.modules.Module._resolveFilename(entry, undefined);
      } catch (error) {
        if ((error as { code?: string }).code === 'MODULE_NOT_FOUND') throw Object.assign(new Error(`Cannot find module '${entry}'`), { code: 'MODULE_NOT_FOUND', requireStack: [] });
        throw error;
      }
      return instance.modules.runMain(resolved).__tla;
    }
    if (source !== undefined) {
      const result = evalInProcess(instance, ctx.cwd, '[eval]', source);
      if (cli.print) instance.process.stdout.write(inspect(result) + '\n');
      return undefined;
    }
    startRepl(instance, ctx);
    return undefined;
  });
  const code = await instance.exit;
  ctx.signal.removeEventListener('abort', onAbort);
  untrap?.();
  return code;
};
