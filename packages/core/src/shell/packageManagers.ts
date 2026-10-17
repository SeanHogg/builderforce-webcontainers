/**
 * `pnpm` and `yarn`, as front ends to the same installer and script runner
 * `npm` uses: their commands are translated to npm's, so `pnpm add -D x`,
 * `yarn dev` or `pnpm dlx create-vite` behave as a project's README expects.
 * The tree is npm-style (hoisted `node_modules`, `package-lock.json`);
 * `pnpm-lock.yaml` and `yarn.lock` are not read.
 */
import { join } from '../paths.js';
import { findPackageScope } from '../node/resolve.js';
import { findExecutable } from '../system/commands.js';
import type { CommandContext } from './context.js';
import type { JobInput, Shell } from './exec.js';
import { npmCommand, npxCommand } from './npm.js';

const VERSIONS = { pnpm: '9.12.0', yarn: '1.22.22' } as const;

type Manager = keyof typeof VERSIONS;

const INSTALL = new Set(['install', 'i']);
const REMOVE = new Set(['remove', 'rm', 'uninstall', 'un']);
const NPM_PASSTHROUGH = new Set(['test', 't', 'start', 'init', 'ls', 'list', 'run', 'run-script']);

function hasScript(ctx: CommandContext, name: string): boolean {
  const dir = findPackageScope(ctx.fs, ctx.cwd)?.dir ?? ctx.cwd;
  try {
    const pkg = JSON.parse(ctx.fs.readText(join(dir, 'package.json')) ?? '{}') as { scripts?: Record<string, string> };
    return !!pkg.scripts?.[name];
  } catch {
    return false;
  }
}

/** Map `--dev` / `-D` to npm's flag; drop flags npm has no use for here. */
function addFlags(args: string[]): string[] {
  return args.flatMap((a) => (a === '--dev' || a === '-D' || a === '--save-dev' ? ['--save-dev'] : a === '--frozen-lockfile' || a === '--immutable' || a === '--prefer-offline' ? [] : [a]));
}

/** The npm (or npx) command line a pnpm/yarn command stands for, or a message when there is none. */
export function translate(manager: Manager, args: string[], ctx: CommandContext): { tool: 'npm' | 'npx'; args: string[] } | { version: string } | { error: string } {
  const [sub, ...rest] = args;
  if (sub === undefined) return { tool: 'npm', args: ['install'] };
  if (sub === '-v' || sub === '--version') return { version: VERSIONS[manager] };
  if (INSTALL.has(sub)) {
    // `yarn install x` is an error in yarn; treat any operands as `add` for both.
    const flags = addFlags(rest);
    return { tool: 'npm', args: ['install', ...flags] };
  }
  if (sub === 'add') return { tool: 'npm', args: ['install', ...addFlags(rest)] };
  if (REMOVE.has(sub)) return { tool: 'npm', args: ['uninstall', ...rest] };
  if (sub === 'dlx' || sub === 'exec' || (manager === 'pnpm' && sub === 'x')) return { tool: 'npx', args: rest };
  if (NPM_PASSTHROUGH.has(sub)) return { tool: 'npm', args: [sub, ...rest] };
  // `pnpm dev` / `yarn build`: a script of that name, else an installed bin.
  if (hasScript(ctx, sub)) return { tool: 'npm', args: ['run', sub, ...(rest.length ? ['--', ...rest] : [])] };
  if (findExecutable(ctx.fs, sub, ctx.cwd, { PATH: '' })) return { tool: 'npx', args: [sub, ...rest] };
  return { error: `${manager}: no script or command named "${sub}"` };
}

function frontEnd(manager: Manager) {
  return async (ctx: CommandContext, shell: Shell, input: JobInput): Promise<number> => {
    const plan = translate(manager, ctx.args, ctx);
    if ('version' in plan) {
      ctx.io.stdout(`${plan.version}\n`);
      return 0;
    }
    if ('error' in plan) {
      ctx.io.stderr(`${plan.error}\n`);
      return 1;
    }
    const next = { ...ctx, args: plan.args, name: plan.tool };
    return plan.tool === 'npm' ? npmCommand(next, shell, input) : npxCommand(next, shell, input);
  };
}

export const pnpmCommand = frontEnd('pnpm');
export const yarnCommand = frontEnd('yarn');
