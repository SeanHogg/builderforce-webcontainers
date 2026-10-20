/**
 * Shell options (`set -o NAME` / `set +o NAME`, and the same flags when invoking
 * `bfsh`). Only `pipefail` exists so far. It is ON by default: a pipeline fails
 * when any stage fails, which the Builderforce canvas relies on to see a failing
 * `build 2>&1 | tail`. `set +o pipefail` (or `bfsh +o pipefail -c …`) opts a
 * script out to POSIX behaviour, where a pipeline's status is its last stage's.
 */
import type { CommandContext } from './context.js';

export interface ShellSettings {
  pipefail: boolean;
}

export const DEFAULT_SHELL_SETTINGS: Readonly<ShellSettings> = { pipefail: true };

const NAMES = Object.keys(DEFAULT_SHELL_SETTINGS) as Array<keyof ShellSettings>;

const isName = (name: string | undefined): name is keyof ShellSettings => NAMES.includes(name as keyof ShellSettings);

/**
 * Leading `-o NAME` / `+o NAME` pairs of a `bfsh` invocation, applied to
 * `settings`; returns the arguments after them, or an error message.
 */
export function takeInvocationOptions(args: string[], settings: ShellSettings): { rest: string[] } | { error: string } {
  let i = 0;
  while ((args[i] === '-o' || args[i] === '+o') && i + 1 < args.length) {
    const name = args[i + 1];
    if (!isName(name)) return { error: `bfsh: ${name}: invalid option name` };
    settings[name] = args[i] === '-o';
    i += 2;
  }
  return { rest: args.slice(i) };
}

/** The state `set` changes. */
export interface SetTarget {
  settings: ShellSettings;
  positional: string[];
}

/** Real `set -o` names this shell does not model: accepted and ignored, like their short flags. */
const ACCEPTED_UNMODELLED = new Set([
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace', 'hashall', 'histexpand',
  'history', 'ignoreeof', 'interactive-comments', 'keyword', 'monitor', 'noclobber', 'noexec',
  'noglob', 'nolog', 'notify', 'nounset', 'onecmd', 'physical', 'posix', 'privileged', 'verbose',
  'vi', 'xtrace',
]);

/**
 * The `set` builtin: `set -o NAME` / `set +o NAME` and clustered short flags
 * (`-euo pipefail`), `set -o` / `set +o` to list, and `set -- ARGS…` to replace
 * the positional parameters. Only `pipefail` is modelled; other real options
 * (`-e`, `-u`, `-x`, errexit…) are accepted and ignored as the shell always did,
 * and an unknown option name is refused (status 2), as bash does.
 */
export async function setBuiltin(ctx: CommandContext, shell: SetTarget): Promise<number> {
  const args = ctx.args;
  if (!args.length || (args.length === 1 && (args[0] === '-o' || args[0] === '+o'))) {
    const listing = args[0] === '+o'
      ? NAMES.map((name) => `set ${shell.settings[name] ? '-o' : '+o'} ${name}\n`)
      : NAMES.map((name) => `${name.padEnd(15)}${shell.settings[name] ? 'on' : 'off'}\n`);
    ctx.io.stdout(listing.join(''));
    return 0;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      shell.positional = args.slice(i + 1);
      return 0;
    }
    // `-o NAME` / `+o NAME`, and clustered short flags (`-euo pipefail`, `+x`): only
    // `pipefail` is modelled. Every other option (errexit, nounset, xtrace, -e, -u, -x)
    // is accepted and ignored, as before, so ordinary `set -euo pipefail` headers in
    // npm scripts keep working.
    const flags = /^[-+][a-zA-Z]+$/.test(arg) ? arg.slice(1) : undefined;
    if (flags === undefined) {
      shell.positional = args.slice(i);
      return 0;
    }
    const on = arg[0] === '-';
    for (const flag of flags) {
      if (flag !== 'o') continue;
      const name = args[++i];
      if (name === undefined) {
        ctx.io.stderr('bfsh: set: -o: option name required\n');
        return 2;
      }
      if (isName(name)) shell.settings[name] = on;
      else if (!ACCEPTED_UNMODELLED.has(name)) {
        ctx.io.stderr(`bfsh: set: ${name}: invalid option name\n`);
        return 2;
      }
    }
  }
  return 0;
}

/** A pipeline's status from its stages': the rightmost non-zero under pipefail, else the last stage's. */
export function pipelineStatus(statuses: number[], settings: ShellSettings): number {
  if (!settings.pipefail) return statuses[statuses.length - 1] ?? 0;
  let status = 0;
  for (const stage of statuses) if (stage !== 0) status = stage;
  return status;
}
