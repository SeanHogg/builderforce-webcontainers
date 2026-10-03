/**
 * Command lookup, shared by the kernel, the browser host and the shell:
 * registered programs first (node, npm, jsh, coreutils), then a path or a
 * `PATH`/`node_modules/.bin` lookup. A found file runs under `node` (a `.bin`
 * shim runs its target directly) or, with a shell shebang, under `jsh`.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, extname, join, normalizePath } from '../paths.js';
import { readBinLink } from '../installer/bins.js';
import type { Program } from './types.js';

export interface ResolvedCommand {
  /** The registered program that will run (`node`, `jsh`, `ls`…). */
  name: string;
  program: Program;
  args: string[];
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
export function interpreterFor(fs: VirtualFileSystem, path: string): { name: 'node' | 'jsh'; args: string[] } {
  const target = readBinLink(fs, path);
  if (target) return { name: 'node', args: [target] };
  const firstLine = (fs.readText(path) ?? '').split('\n', 1)[0] ?? '';
  if (/^#!.*\b(?:sh|bash|jsh|zsh|dash)\b/.test(firstLine)) return { name: 'jsh', args: [path] };
  if (['.sh', '.bash'].includes(extname(path))) return { name: 'jsh', args: [path] };
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
  const file = findExecutable(fs, command, cwd, env);
  if (!file) return undefined;
  const { name, args: lead } = interpreterFor(fs, file);
  const program = programs[name];
  return program ? { name, program, args: [...lead, ...args] } : undefined;
}

export function commandNotFound(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT', errno: -2, syscall: `spawn ${command}`, path: command });
}
