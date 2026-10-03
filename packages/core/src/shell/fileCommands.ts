/**
 * File coreutils over the VFS: ls, cat, mkdir, rm, cp, mv, touch, pwd. Errors
 * read like GNU coreutils (`rm: cannot remove 'x': No such file or directory`)
 * because people (and agents) pattern-match on them.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { basename, dirname, join } from '../paths.js';
import { parseFlags, resolvePath, type Command } from './context.js';

const encoder = new TextEncoder();
const sizeOf = (fs: VirtualFileSystem, path: string) => {
  const c = fs.readFile(path);
  return c === undefined ? 4096 : typeof c === 'string' ? encoder.encode(c).length : c.length;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function lsDate(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export const ls: Command = async (ctx) => {
  const { flags, operands } = parseFlags(ctx.args);
  const all = flags.has('a') || flags.has('A');
  const long = flags.has('l');
  const one = flags.has('1') || !ctx.io.isTerminal;
  const targets = operands.length ? operands : ['.'];
  let status = 0;
  const colour = (name: string, dir: boolean) => (ctx.io.isTerminal && dir ? `\x1b[1;34m${name}\x1b[0m` : name);
  const render = (dir: string, names: string[]) => {
    if (long) {
      const lines = names.map((name) => {
        const path = name === '.' ? dir : name === '..' ? dirname(dir) : join(dir, name);
        const isDir = ctx.fs.isDirectory(path);
        const size = isDir ? 4096 : sizeOf(ctx.fs, path);
        return `${isDir ? 'drwxr-xr-x' : '-rw-r--r--'} 1 user user ${String(size).padStart(8)} ${lsDate(ctx.fs.mtime(path) ?? Date.now())} ${colour(name, isDir)}`;
      });
      return lines.length ? `total ${names.length}\n${lines.join('\n')}\n` : 'total 0\n';
    }
    const shown = names.map((n) => colour(n, ctx.fs.isDirectory(join(dir, n))));
    return shown.length ? shown.join(one ? '\n' : '  ') + '\n' : '';
  };
  for (const [index, target] of targets.entries()) {
    const path = resolvePath(ctx, target);
    if (ctx.fs.isFile(path)) {
      ctx.io.stdout(render(dirname(path), [basename(path)]).replace(basename(path), target));
      continue;
    }
    if (!ctx.fs.isDirectory(path)) {
      ctx.io.stderr(`ls: cannot access '${target}': No such file or directory\n`);
      status = 2;
      continue;
    }
    let names = ctx.fs.readdir(path).filter((n) => all || !n.startsWith('.'));
    if (flags.has('a')) names = ['.', '..', ...names];
    if (targets.length > 1) ctx.io.stdout(`${index ? '\n' : ''}${target}:\n`);
    ctx.io.stdout(render(path, names));
  }
  return status;
};

export const cat: Command = async (ctx) => {
  const { operands } = parseFlags(ctx.args);
  if (!operands.length || (operands.length === 1 && operands[0] === '-')) {
    ctx.io.stdout(await ctx.io.stdin.readAll());
    return 0;
  }
  let status = 0;
  for (const file of operands) {
    const path = resolvePath(ctx, file);
    if (ctx.fs.isDirectory(path)) {
      ctx.io.stderr(`cat: ${file}: Is a directory\n`);
      status = 1;
    } else if (!ctx.fs.isFile(path)) {
      ctx.io.stderr(`cat: ${file}: No such file or directory\n`);
      status = 1;
    } else ctx.io.stdout(ctx.fs.readText(path) ?? '');
  }
  return status;
};

export const mkdir: Command = async (ctx) => {
  const { flags, operands } = parseFlags(ctx.args, ['m']);
  if (!operands.length) {
    ctx.io.stderr('mkdir: missing operand\n');
    return 1;
  }
  let status = 0;
  for (const dir of operands) {
    const path = resolvePath(ctx, dir);
    if (ctx.fs.exists(path)) {
      if (flags.has('p') && ctx.fs.isDirectory(path)) continue;
      ctx.io.stderr(`mkdir: cannot create directory '${dir}': File exists\n`);
      status = 1;
    } else if (!flags.has('p') && !ctx.fs.isDirectory(dirname(path))) {
      ctx.io.stderr(`mkdir: cannot create directory '${dir}': No such file or directory\n`);
      status = 1;
    } else ctx.fs.mkdir(path);
  }
  return status;
};

export const rm: Command = async (ctx) => {
  const { flags, operands } = parseFlags(ctx.args);
  const recursive = flags.has('r') || flags.has('R') || flags.has('recursive');
  const force = flags.has('f') || flags.has('force');
  if (!operands.length && !force) {
    ctx.io.stderr('rm: missing operand\n');
    return 1;
  }
  let status = 0;
  for (const target of operands) {
    const path = resolvePath(ctx, target);
    if (path === '/') {
      ctx.io.stderr(`rm: it is dangerous to operate recursively on '/'\n`);
      status = 1;
    } else if (!ctx.fs.exists(path)) {
      if (!force) {
        ctx.io.stderr(`rm: cannot remove '${target}': No such file or directory\n`);
        status = 1;
      }
    } else if (ctx.fs.isDirectory(path) && !recursive) {
      ctx.io.stderr(`rm: cannot remove '${target}': Is a directory\n`);
      status = 1;
    } else ctx.fs.rm(path);
  }
  return status;
};

function copyTree(fs: VirtualFileSystem, from: string, to: string): void {
  if (fs.isFile(from)) {
    const c = fs.readFile(from)!;
    fs.writeFile(to, typeof c === 'string' ? c : c.slice());
    return;
  }
  fs.mkdir(to);
  for (const name of fs.readdir(from)) copyTree(fs, join(from, name), join(to, name));
}

/** cp and mv share argument handling: `SRC… DEST` where DEST may be a directory. */
function transfer(verb: 'cp' | 'mv'): Command {
  return async (ctx) => {
    const { flags, operands } = parseFlags(ctx.args);
    if (operands.length < 2) {
      ctx.io.stderr(`${verb}: missing destination file operand\n`);
      return 1;
    }
    const dest = resolvePath(ctx, operands[operands.length - 1]!);
    const sources = operands.slice(0, -1);
    const destIsDir = ctx.fs.isDirectory(dest);
    if (sources.length > 1 && !destIsDir) {
      ctx.io.stderr(`${verb}: target '${operands[operands.length - 1]}' is not a directory\n`);
      return 1;
    }
    let status = 0;
    for (const source of sources) {
      const from = resolvePath(ctx, source);
      const to = destIsDir ? join(dest, basename(from)) : dest;
      if (!ctx.fs.exists(from)) {
        ctx.io.stderr(`${verb}: cannot stat '${source}': No such file or directory\n`);
        status = 1;
        continue;
      }
      if (verb === 'cp' && ctx.fs.isDirectory(from) && !(flags.has('r') || flags.has('R') || flags.has('a'))) {
        ctx.io.stderr(`cp: -r not specified; omitting directory '${source}'\n`);
        status = 1;
        continue;
      }
      if (to === from || to.startsWith(from + '/')) {
        ctx.io.stderr(`${verb}: cannot ${verb === 'cp' ? 'copy' : 'move'} '${source}' into itself\n`);
        status = 1;
        continue;
      }
      if (ctx.fs.isFile(to) && ctx.fs.isDirectory(from)) {
        ctx.io.stderr(`${verb}: cannot overwrite non-directory '${to}' with directory '${source}'\n`);
        status = 1;
        continue;
      }
      if (ctx.fs.isFile(to)) ctx.fs.rm(to);
      copyTree(ctx.fs, from, to);
      if (verb === 'mv') ctx.fs.rm(from);
    }
    return status;
  };
}

export const cp = transfer('cp');
export const mv = transfer('mv');

export const touch: Command = async (ctx) => {
  const { operands } = parseFlags(ctx.args);
  let status = 0;
  for (const file of operands) {
    const path = resolvePath(ctx, file);
    if (!ctx.fs.isDirectory(dirname(path))) {
      ctx.io.stderr(`touch: cannot touch '${file}': No such file or directory\n`);
      status = 1;
    } else if (!ctx.fs.isDirectory(path)) ctx.fs.writeFile(path, ctx.fs.readFile(path) ?? '');
  }
  return status;
};

export const pwd: Command = async (ctx) => {
  ctx.io.stdout(ctx.cwd + '\n');
  return 0;
};
