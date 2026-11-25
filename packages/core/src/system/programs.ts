/**
 * The command table: every program a process can be. Hosts start from
 * `defaultPrograms()` and may add or replace entries (a custom `git`, say).
 *
 * `npm`/`npx`/`pnpm`/`yarn` live in the shell (they run scripts through it), so spawning them
 * directly runs them through a one-shot shell; coreutils run standalone.
 */
import type { Program } from './types.js';
import { nodeProgram } from '../node/program.js';
import { shellProgram } from '../shell/program.js';
import { COREUTILS } from '../shell/builtins.js';
import { asProgram } from '../shell/context.js';
import { DEV_SERVER_TOOLS, devServerProgram } from '../shell/devHandoff.js';

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

function viaShell(command: string): Program {
  return (ctx) => shellProgram({ ...ctx, args: ['-c', [command, ...ctx.args].map(quote).join(' ')] });
}

export function defaultPrograms(): Record<string, Program> {
  const programs: Record<string, Program> = {
    node: nodeProgram,
    bfsh: shellProgram,
    sh: shellProgram,
    bash: shellProgram,
    npm: viaShell('npm'),
    npx: viaShell('npx'),
    pnpm: viaShell('pnpm'),
    yarn: viaShell('yarn'),
  };
  for (const [name, command] of Object.entries(COREUTILS)) programs[name] = asProgram(command, name);
  // `vite`, `react-scripts`, `craco`, `ng`: the in-browser dev server's handoff, for a direct spawn (a service's plain command).
  // `resolveCommand` picks it only when the handoff applies; otherwise these resolve as any command (the installed binary, or not found).
  for (const name of DEV_SERVER_TOOLS) programs[name] = devServerProgram(name);
  return programs;
}
