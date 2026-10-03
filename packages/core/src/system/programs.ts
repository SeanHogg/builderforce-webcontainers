/**
 * The command table: every program a process can be. Hosts start from
 * `defaultPrograms()` and may add or replace entries (a custom `git`, say).
 *
 * `npm`/`npx` live in the shell (they run scripts through it), so spawning them
 * directly runs them through a one-shot shell; coreutils run standalone.
 */
import type { Program } from './types.js';
import { nodeProgram } from '../node/program.js';
import { shellProgram } from '../shell/program.js';
import { COREUTILS } from '../shell/builtins.js';
import { asProgram } from '../shell/context.js';

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

function viaShell(command: string): Program {
  return (ctx) => shellProgram({ ...ctx, args: ['-c', [command, ...ctx.args].map(quote).join(' ')] });
}

export function defaultPrograms(): Record<string, Program> {
  const programs: Record<string, Program> = {
    node: nodeProgram,
    jsh: shellProgram,
    sh: shellProgram,
    bash: shellProgram,
    npm: viaShell('npm'),
    npx: viaShell('npx'),
  };
  for (const [name, command] of Object.entries(COREUTILS)) programs[name] = asProgram(command, name);
  return programs;
}
