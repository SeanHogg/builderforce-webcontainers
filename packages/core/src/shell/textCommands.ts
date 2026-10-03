/**
 * Text coreutils: echo, printf, head, tail, grep, wc, env, clear, sleep,
 * basename, dirname, true, false. Each reads named files or, without any,
 * stdin — so they work at either end of a pipe.
 */
import { basename as baseOf, dirname as dirOf, join } from '../paths.js';
import { parseFlags, resolvePath, type Command, type CommandContext } from './context.js';

/** Contents of each operand file, or stdin when there are none. */
async function inputs(ctx: CommandContext, operands: string[], name: string): Promise<Array<{ label: string; text: string }> | number> {
  if (!operands.length || (operands.length === 1 && operands[0] === '-')) return [{ label: '(standard input)', text: await ctx.io.stdin.readAll() }];
  const out: Array<{ label: string; text: string }> = [];
  for (const file of operands) {
    const path = resolvePath(ctx, file);
    if (!ctx.fs.isFile(path)) {
      ctx.io.stderr(`${name}: ${file}: ${ctx.fs.isDirectory(path) ? 'Is a directory' : 'No such file or directory'}\n`);
      return 1;
    }
    out.push({ label: file, text: ctx.fs.readText(path) ?? '' });
  }
  return out;
}

const lines = (text: string) => {
  const list = text.split('\n');
  if (list[list.length - 1] === '') list.pop();
  return list;
};

function unescape(text: string): string {
  return text.replace(/\\(n|t|r|\\|e|a|0)/g, (_m, c: string) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', e: '\x1b', a: '\x07', 0: '\0' })[c] ?? c);
}

export const echo: Command = async (ctx) => {
  let args = ctx.args;
  let newline = true;
  let escapes = false;
  while (args[0] && /^-[neE]+$/.test(args[0])) {
    if (args[0].includes('n')) newline = false;
    if (args[0].includes('e')) escapes = true;
    args = args.slice(1);
  }
  const text = args.join(' ');
  ctx.io.stdout((escapes ? unescape(text) : text) + (newline ? '\n' : ''));
  return 0;
};

export const printf: Command = async (ctx) => {
  const [format = '', ...rest] = ctx.args;
  let i = 0;
  const out = unescape(format).replace(/%([sdif%])/g, (_m, spec: string) => {
    if (spec === '%') return '%';
    const arg = rest[i++] ?? '';
    return spec === 's' ? arg : String(spec === 'f' ? parseFloat(arg) || 0 : parseInt(arg, 10) || 0);
  });
  ctx.io.stdout(out);
  return 0;
};

function headTail(which: 'head' | 'tail'): Command {
  return async (ctx) => {
    const numeric = ctx.args.find((a) => /^-\d+$/.test(a));
    const { values, operands } = parseFlags(ctx.args.filter((a) => a !== numeric), ['n']);
    const count = numeric ? Number(numeric.slice(1)) : values.n !== undefined ? Number(values.n) : 10;
    const files = await inputs(ctx, operands, which);
    if (typeof files === 'number') return files;
    files.forEach((file, index) => {
      if (files.length > 1) ctx.io.stdout(`${index ? '\n' : ''}==> ${file.label} <==\n`);
      const all = lines(file.text);
      const picked = which === 'head' ? all.slice(0, count) : count ? all.slice(-count) : [];
      if (picked.length) ctx.io.stdout(picked.join('\n') + '\n');
    });
    return 0;
  };
}
export const head = headTail('head');
export const tail = headTail('tail');

export const grep: Command = async (ctx) => {
  const { flags, operands } = parseFlags(ctx.args);
  const [pattern, ...files] = operands;
  if (pattern === undefined) {
    ctx.io.stderr('Usage: grep [-ivnrclEF] PATTERN [FILE]...\n');
    return 2;
  }
  let re: RegExp;
  try {
    const source = flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : flags.has('E') ? pattern : pattern.replace(/\\([|(){}+?])/g, '$1');
    re = new RegExp(flags.has('w') ? `\\b(?:${source})\\b` : source, flags.has('i') ? 'i' : '');
  } catch {
    ctx.io.stderr(`grep: invalid pattern: ${pattern}\n`);
    return 2;
  }
  let targets = files;
  if (flags.has('r') || flags.has('R')) {
    targets = [];
    const walk = (path: string, label: string) => {
      if (ctx.fs.isFile(path)) targets.push(label);
      else for (const name of ctx.fs.readdir(path)) if (name !== 'node_modules' && !name.startsWith('.')) walk(join(path, name), label === '.' ? name : `${label}/${name}`);
    };
    for (const f of files.length ? files : ['.']) walk(resolvePath(ctx, f), f);
  }
  const sources = await inputs(ctx, targets, 'grep');
  if (typeof sources === 'number') return 2;
  const prefix = sources.length > 1;
  let matched = 0;
  for (const { label, text } of sources) {
    let count = 0;
    lines(text).forEach((line, index) => {
      if (re.test(line) === flags.has('v')) return;
      count++;
      matched++;
      if (flags.has('c') || flags.has('l') || flags.has('q')) return;
      ctx.io.stdout(`${prefix ? label + ':' : ''}${flags.has('n') ? index + 1 + ':' : ''}${line}\n`);
    });
    if (flags.has('c')) ctx.io.stdout(`${prefix ? label + ':' : ''}${count}\n`);
    if (flags.has('l') && count) ctx.io.stdout(label + '\n');
  }
  return matched ? 0 : 1;
};

export const wc: Command = async (ctx) => {
  const { flags, operands } = parseFlags(ctx.args);
  const files = await inputs(ctx, operands, 'wc');
  if (typeof files === 'number') return files;
  const only = ['l', 'w', 'c'].filter((f) => flags.has(f));
  for (const { label, text } of files) {
    const counts: Record<string, number> = { l: (text.match(/\n/g) ?? []).length, w: text.split(/\s+/).filter(Boolean).length, c: new TextEncoder().encode(text).length };
    const shown = (only.length ? only : ['l', 'w', 'c']).map((f) => String(counts[f]).padStart(7)).join(' ');
    ctx.io.stdout(`${shown}${operands.length ? ' ' + label : ''}\n`);
  }
  return 0;
};

export const env: Command = async (ctx) => {
  ctx.io.stdout(Object.entries(ctx.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return 0;
};

export const clear: Command = async (ctx) => {
  ctx.io.stdout('\x1b[2J\x1b[3J\x1b[H');
  return 0;
};

export const sleep: Command = async (ctx) => {
  const seconds = Number(ctx.args[0] ?? 0);
  if (!Number.isFinite(seconds)) {
    ctx.io.stderr(`sleep: invalid time interval '${ctx.args[0]}'\n`);
    return 1;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    ctx.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return ctx.signal.aborted ? 130 : 0;
};

export const basename: Command = async (ctx) => {
  const [path = '', suffix] = ctx.args;
  let base = baseOf(path);
  if (suffix && base.endsWith(suffix) && base !== suffix) base = base.slice(0, -suffix.length);
  ctx.io.stdout(base + '\n');
  return 0;
};

export const dirname: Command = async (ctx) => {
  const path = (ctx.args[0] ?? '.').replace(/(.)\/+$/, '$1');
  const cut = path.lastIndexOf('/');
  ctx.io.stdout((cut < 0 ? '.' : cut === 0 ? '/' : path.startsWith('/') ? dirOf(path) : path.slice(0, cut)) + '\n');
  return 0;
};

export const trueCommand: Command = async () => 0;
export const falseCommand: Command = async () => 1;
