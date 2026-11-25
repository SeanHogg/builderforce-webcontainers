/**
 * Dev-server handoff. `vite`, `vite dev`, `react-scripts start`, `ng serve`
 * (what `npm run dev` / `npm start` usually run) need not boot a bundler at
 * all: the runtime already IS a Vite-style dev server, the in-browser DevServer
 * serving the preview (it compiles React, Vue, Svelte and Angular), and it
 * starts instantly. So these commands announce that preview as their server (a
 * listening announcement) and stay "running" until Ctrl-C, which is exactly
 * what a host waiting on `npm run dev` expects.
 *
 * The project is the working directory: a frontend in `/web` of a project
 * whose backend is in `/api` is announced with that directory as its root, and
 * the host serves `/web` (its `index.html`, `src/`, config) at the preview URL.
 *
 * Not for a framework that runs its own server on top of Vite (SvelteKit, Nuxt…,
 * `ownServerReason`): those run the real, installed Vite, on esbuild's and
 * Rollup's wasm builds (installer/wasmBuilds.ts). Nor when no preview is attached.
 */
import type { CommandContext } from './context.js';
import type { Program } from '../system/types.js';
import { ownServerReason } from '../detectProject.js';
import { rootedFileSystem } from '../rootedFs.js';
import { InputQueue } from '../system/terminal.js';
import type { VirtualFileSystem } from '../vfs.js';

interface Handoff {
  tool: 'vite' | 'react-scripts' | 'angular';
  defaultPort: number;
}

/** The ONE table of handed-off tools: their handoff and the subcommands (none = bare) that start the dev server. `ng dev` is not a command. */
const DEV_SERVERS: Readonly<Record<string, Handoff & { subcommands: ReadonlyArray<string | undefined> }>> = {
  vite: { tool: 'vite', defaultPort: 5173, subcommands: [undefined, 'dev', 'serve'] },
  'react-scripts': { tool: 'react-scripts', defaultPort: 3000, subcommands: ['start'] },
  craco: { tool: 'react-scripts', defaultPort: 3000, subcommands: ['start'] },
  // The Angular CLI's dev server (`ng serve`, alias `ng s`).
  ng: { tool: 'angular', defaultPort: 4200, subcommands: ['serve', 's'] },
};

/** The command names a dev-server handoff answers to: registered as programs (`system/programs.ts`) so a bare `vite` service command resolves. */
export const DEV_SERVER_TOOLS: readonly string[] = Object.keys(DEV_SERVERS);

/** Does this command line start a dev server we hand off? */
export function matchDevServer(argv: string[]): Handoff | undefined {
  const [command, ...rest] = argv;
  const row = command !== undefined && Object.prototype.hasOwnProperty.call(DEV_SERVERS, command) ? DEV_SERVERS[command] : undefined;
  const sub = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : undefined;
  return row && row.subcommands.includes(sub) ? { tool: row.tool, defaultPort: row.defaultPort } : undefined;
}

/**
 * The program a handoff tool name runs as when it is spawned directly (a service's `command: "vite"`)
 * rather than from a shell line. It exists ONLY for the handoff: `resolveCommand` resolves a dev-server tool
 * to it when `handoffFor` applies, and otherwise to the installed binary (or "not found") like any command,
 * so a direct spawn keeps its `ipc`, `thread`, `detached` and byte stdio.
 */
export function devServerProgram(name: string): Program {
  return async (program) => {
    const ctx: CommandContext = {
      args: program.args,
      name,
      cwd: program.cwd,
      env: program.env,
      fs: program.system.fs,
      system: program.system,
      io: { stdout: program.io.stdout, stderr: program.io.stderr, stdin: new InputQueue(), isTerminal: !!program.io.terminal },
      signal: program.signal,
    };
    const argv = [name, ...program.args];
    const handoff = devServerHandoff(ctx, argv);
    if (handoff) return runDevServerHandoff(ctx, argv, handoff);
    // `resolveCommand` hands this program a command only when the handoff applies; reaching here means it was asked for directly.
    ctx.io.stderr(`bfsh: command not found: ${name}\n`);
    return 127;
  };
}

/**
 * The handoff for this command line in `cwd`, when a preview is attached and can serve the project instead.
 * The ONE condition: the shell asks it (`devServerHandoff`) and so does command resolution (`resolveCommand`), which
 * resolves a dev-server tool to the handoff program only then — otherwise to the installed binary, as any command.
 */
export function handoffFor(fs: VirtualFileSystem, cwd: string, previewUrl: string | undefined, argv: string[]): Handoff | undefined {
  const handoff = matchDevServer(argv);
  // The project is the working directory (`npm run` starts scripts in the package's own).
  return handoff && previewUrl && !ownServerReason(rootedFileSystem(fs, cwd)) ? handoff : undefined;
}

/** The handoff for this command line, when the attached preview can serve the project instead. */
export function devServerHandoff(ctx: CommandContext, argv: string[]): Handoff | undefined {
  return handoffFor(ctx.fs, ctx.cwd, ctx.system.previewUrl, argv);
}

function portOf(argv: string[], fallback: number, env: Record<string, string>): number {
  const at = argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  const value = at < 0 ? env.PORT : argv[at]!.includes('=') ? argv[at]!.split('=')[1] : argv[at + 1];
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

const BANNERS: Record<Handoff['tool'], (url: string) => string> = {
  vite: (url) => `\n  VITE (BuilderForce in-browser dev server)  ready\n\n  ➜  Local:   ${url}\n\n`,
  'react-scripts': (url) => `\nCompiled successfully!\n\nYou can now view the app in the browser.\n\n  Local:  ${url}\n\n`,
  angular: (url) => `\nApplication bundle generation complete. (BuilderForce in-browser dev server)\n\n  ➜  Local:   ${url}\n\n`,
};

export async function runDevServerHandoff(ctx: CommandContext, argv: string[], handoff: Handoff): Promise<number> {
  const url = ctx.system.previewUrl!; // devServerHandoff only matches with a preview attached
  const port = portOf(argv, handoff.defaultPort, ctx.env);
  ctx.io.stdout(BANNERS[handoff.tool](url));
  const withdraw = ctx.system.announceServer(port, url, ctx.cwd);
  await new Promise<void>((resolve) => {
    if (ctx.signal.aborted) resolve();
    ctx.signal.addEventListener('abort', () => resolve());
  });
  // Interrupted: the host goes back to what it served before (the shell that ran it may live on).
  withdraw?.();
  return 130;
}
