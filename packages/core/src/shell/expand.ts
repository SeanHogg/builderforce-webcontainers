/**
 * Word expansion, in sh order: tilde, parameters (`$X`, `${X:-d}`, `$?`, `$1`),
 * command substitution, field splitting of UNQUOTED results, then pathname
 * globbing (`*`, `?`, `[…]`) of unquoted patterns. A glob with no match stays
 * literal, as in bash without `nullglob`.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { join, normalizePath } from '../paths.js';
import type { Segment, Word } from './parse.js';

export interface ExpandContext {
  fs: VirtualFileSystem;
  cwd: string;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  positional: string[];
  lastStatus: number;
  pid: number;
  /** Run `$(…)` and return its stdout. */
  substitute(source: string): Promise<string>;
}

async function paramValue(seg: Extract<Segment, { kind: 'var' }>, ctx: ExpandContext): Promise<string> {
  let value: string | undefined;
  switch (seg.name) {
    case '?': value = String(ctx.lastStatus); break;
    case '$': value = String(ctx.pid); break;
    case '#': value = String(ctx.positional.length); break;
    case '@':
    case '*': value = ctx.positional.join(' '); break;
    case '!': value = ''; break;
    case '0': value = 'jsh'; break;
    default: value = /^\d$/.test(seg.name) ? ctx.positional[Number(seg.name) - 1] : ctx.get(seg.name);
  }
  if (!seg.op) return value ?? '';
  const arg = async () => (await expandWord(seg.arg ?? [], ctx, { split: false, glob: false })).join(' ');
  switch (seg.op) {
    case ':-': return value ? value : arg();
    case '-': return value !== undefined ? value : arg();
    case ':+': return value ? arg() : '';
    case ':=': {
      if (value) return value;
      const fallback = await arg();
      ctx.set(seg.name, fallback);
      return fallback;
    }
  }
}

const GLOB_CHARS = /[*?[]/;

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end < 0) source += '\\[';
      else {
        source += '[' + pattern.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else source += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export function glob(fs: VirtualFileSystem, cwd: string, pattern: string): string[] {
  const absolute = pattern.startsWith('/');
  const parts = pattern.split('/').filter((p, i) => p || i === 0);
  let matches: string[] = [absolute ? '/' : ''];
  for (const part of absolute ? parts.slice(1) : parts) {
    const next: string[] = [];
    for (const base of matches) {
      const dir = base ? (base.startsWith('/') ? base : join(cwd, base)) : cwd;
      if (!GLOB_CHARS.test(part)) {
        const candidate = base ? (base.endsWith('/') ? base + part : `${base}/${part}`) : part;
        if (fs.exists(candidate.startsWith('/') ? candidate : join(cwd, candidate))) next.push(candidate);
        continue;
      }
      const re = globToRegExp(part);
      for (const name of fs.readdir(normalizePath(dir))) {
        if (name.startsWith('.') && !part.startsWith('.')) continue;
        if (re.test(name)) next.push(base ? (base.endsWith('/') ? base + name : `${base}/${name}`) : name);
      }
    }
    matches = next;
  }
  return matches.sort();
}

/** Expand one word into zero or more fields. */
export async function expandWord(word: Word, ctx: ExpandContext, options: { split?: boolean; glob?: boolean } = {}): Promise<string[]> {
  const split = options.split ?? true;
  const fields: string[] = [''];
  let started = false; // a quoted part (even empty) makes the word a field
  let globbable = false;
  const append = (text: string) => {
    fields[fields.length - 1] += text;
  };
  for (const seg of word) {
    if (seg.kind === 'tilde') {
      append(ctx.get('HOME') ?? '/home/user');
      started = true;
      continue;
    }
    if (seg.kind === 'text') {
      append(seg.value);
      if (seg.quoted || seg.value) started = true;
      if (!seg.quoted && GLOB_CHARS.test(seg.value)) globbable = true;
      continue;
    }
    const value = seg.kind === 'var' ? await paramValue(seg, ctx) : (await ctx.substitute(seg.source)).replace(/\n+$/, '');
    if (seg.quoted || !split) {
      append(value);
      started = true;
      continue;
    }
    const pieces = value.split(/[ \t\n]+/);
    pieces.forEach((piece, index) => {
      if (index > 0 && (fields[fields.length - 1] || started)) fields.push('');
      if (piece) {
        append(piece);
        started = true;
      }
    });
  }
  const result = fields.filter((f, i) => f !== '' || (started && i === fields.length - 1 && fields.length === 1));
  if (!started && result.every((f) => !f)) return [];
  if (options.glob === false || !globbable) return result;
  return result.flatMap((field) => {
    if (!GLOB_CHARS.test(field)) return [field];
    const hits = glob(ctx.fs, ctx.cwd, field);
    return hits.length ? hits : [field];
  });
}

/** Expand every word of a command line. */
export async function expandWords(words: Word[], ctx: ExpandContext): Promise<string[]> {
  const out: string[] = [];
  for (const word of words) out.push(...(await expandWord(word, ctx)));
  return out;
}
