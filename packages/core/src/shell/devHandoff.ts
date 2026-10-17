/**
 * Dev-server handoff. `vite`, `vite dev`, `react-scripts start` (what `npm run
 * dev` / `npm start` usually run) need not boot a bundler at all: the runtime
 * already IS a Vite-style dev server, the in-browser DevServer serving the
 * preview, and it starts instantly. So these commands announce that preview as
 * their server (a listening announcement) and stay "running" until Ctrl-C,
 * which is exactly what a host waiting on `npm run dev` expects.
 *
 * Not for a framework that runs its own server on top of Vite (SvelteKit, Nuxt…,
 * `ownServerReason`): those run the real, installed Vite, on esbuild's and
 * Rollup's wasm builds (installer/wasmBuilds.ts). Nor when no preview is attached.
 */
import type { CommandContext } from './context.js';
import { ownServerReason } from '../detectProject.js';

interface Handoff {
  tool: string;
  defaultPort: number;
}

/** Does this command line start a dev server we hand off? */
export function matchDevServer(argv: string[]): Handoff | undefined {
  const [command, ...rest] = argv;
  const sub = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : undefined;
  if (command === 'vite' && (sub === undefined || sub === 'dev' || sub === 'serve')) return { tool: 'vite', defaultPort: 5173 };
  if ((command === 'react-scripts' || command === 'craco') && sub === 'start') return { tool: 'react-scripts', defaultPort: 3000 };
  return undefined;
}

/** The handoff for this command line, when the attached preview can serve the project instead. */
export function devServerHandoff(ctx: CommandContext, argv: string[]): Handoff | undefined {
  const handoff = matchDevServer(argv);
  return handoff && ctx.system.previewUrl && !ownServerReason(ctx.fs) ? handoff : undefined;
}

function portOf(argv: string[], fallback: number, env: Record<string, string>): number {
  const at = argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  const value = at < 0 ? env.PORT : argv[at]!.includes('=') ? argv[at]!.split('=')[1] : argv[at + 1];
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

export async function runDevServerHandoff(ctx: CommandContext, argv: string[], handoff: Handoff): Promise<number> {
  const url = ctx.system.previewUrl!; // devServerHandoff only matches with a preview attached
  const port = portOf(argv, handoff.defaultPort, ctx.env);
  const banner = handoff.tool === 'vite'
    ? `\n  VITE (BuilderForce in-browser dev server)  ready\n\n  ➜  Local:   ${url}\n\n`
    : `\nCompiled successfully!\n\nYou can now view the app in the browser.\n\n  Local:  ${url}\n\n`;
  ctx.io.stdout(banner);
  ctx.system.announceServer(port, url);
  await new Promise<void>((resolve) => {
    if (ctx.signal.aborted) resolve();
    ctx.signal.addEventListener('abort', () => resolve());
  });
  return 130;
}
