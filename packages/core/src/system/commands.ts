/**
 * Command lookup, shared by the kernel, the browser host and the shell:
 * registered programs first (node, npm, bfsh, coreutils), then a path or a
 * `PATH`/`node_modules/.bin` lookup. A found file runs under `node` (a `.bin`
 * shim runs its target directly) or, with a shell shebang, under `bfsh`.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, extname, join, normalizePath } from '../paths.js';
import { readBinLink } from '../installer/bins.js';
import type { Program } from './types.js';

export interface ResolvedCommand {
  /** The registered program that will run (`node`, `bfsh`, `ls`…). */
  name: string;
  program: Program;
  args: string[];
}

/** Where registered programs live (`which node` → `/usr/local/bin/node`); the default `PATH`. */
export const SYSTEM_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'] as const;

/**
 * `/usr/local/bin/node` → `node`: an absolute path into a system bin directory
 * names the registered program, unless a real file sits there. Tools spawn
 * `process.execPath` this way (Next.js's telemetry flush, worker pools).
 */
function systemProgramName(fs: VirtualFileSystem, command: string): string | undefined {
  if (!command.startsWith('/')) return undefined;
  const path = normalizePath(command);
  if (!(SYSTEM_BIN_DIRS as readonly string[]).includes(dirname(path)) || fs.isFile(path)) return undefined;
  return path.slice(dirname(path).length + 1);
}

/** Every `node_modules/.bin` from `cwd` up to the root, nearest first. */
export function binDirectories(cwd: string): string[] {
  const out: string[] = [];
  for (let dir = normalizePath(cwd); ; dir = dirname(dir)) {
    if (!dir.endsWith('/node_modules')) out.push(join(dir, 'node_modules/.bin'));
    if (dir === '/') return out;
  }
}

/** Find an executable file named `command` on PATH (then node_modules/.bin). */
export function findExecutable(fs: VirtualFileSystem, command: string, cwd: string, env: Record<string, string | undefined>): string | undefined {
  if (command.includes('/')) {
    const path = command.startsWith('/') ? normalizePath(command) : join(cwd, command);
    return fs.isFile(path) ? path : undefined;
  }
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), ...binDirectories(cwd)];
  for (const dir of dirs) {
    const path = join(dir.startsWith('/') ? dir : join(cwd, dir), command);
    if (fs.isFile(path)) return path;
  }
  return undefined;
}

/** How to run a script file: its interpreter and arguments. */
export function interpreterFor(fs: VirtualFileSystem, path: string): { name: 'node' | 'bfsh'; args: string[] } {
  const target = readBinLink(fs, path);
  if (target) return { name: 'node', args: [target] };
  const firstLine = (fs.readText(path) ?? '').split('\n', 1)[0] ?? '';
  if (/^#!.*\b(?:sh|bash|bfsh|zsh|dash)\b/.test(firstLine)) return { name: 'bfsh', args: [path] };
  if (['.sh', '.bash'].includes(extname(path))) return { name: 'bfsh', args: [path] };
  return { name: 'node', args: [path] };
}

export function resolveCommand(
  fs: VirtualFileSystem,
  programs: Readonly<Record<string, Program>>,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string | undefined>,
): ResolvedCommand | undefined {
  if (!command.includes('/') && Object.prototype.hasOwnProperty.call(programs, command)) {
    return { name: command, program: programs[command]!, args };
  }
  const system = systemProgramName(fs, command);
  if (system && Object.prototype.hasOwnProperty.call(programs, system)) return { name: system, program: programs[system]!, args };
  const file = findExecutable(fs, command, cwd, env);
  if (!file) return undefined;
  const { name, args: lead } = interpreterFor(fs, file);
  const program = programs[name];
  return program ? { name, program, args: [...lead, ...args] } : undefined;
}

export function commandNotFound(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${command}`, path: command });
}
