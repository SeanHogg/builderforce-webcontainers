/**
 * The shell grammar, a practical subset of POSIX sh:
 *
 *   script   := list (('\n' | ';' | '&') list)*
 *   list     := pipeline (('&&' | '||') pipeline)*
 *   pipeline := ['!'] command ('|' command)*
 *   command  := (NAME=word)* word* redirect*
 *   redirect := ('>' | '>>' | '<' | '2>' | '2>>' | '&>') word | '2>&1' | '>&2'
 *
 * Words keep their quoting as segments, because expansion (variables, `$(…)`,
 * `~`, globs, field splitting) happens at run time and depends on it.
 */

export type Segment =
  | { kind: 'text'; value: string; quoted: boolean }
  | { kind: 'var'; name: string; quoted: boolean; op?: ':-' | '-' | ':=' | ':+'; arg?: Word }
  | { kind: 'cmd'; source: string; quoted: boolean }
  | { kind: 'tilde' };
export type Word = Segment[];

export type RedirectOp = '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1' | '>&2';
export interface Redirect {
  op: RedirectOp;
  target?: Word;
}
export interface Command {
  assignments: Array<{ name: string; value: Word }>;
  words: Word[];
  redirects: Redirect[];
}
export interface Pipeline {
  negate: boolean;
  commands: Command[];
}
export interface AndOrList {
  first: Pipeline;
  rest: Array<{ op: '&&' | '||'; pipeline: Pipeline }>;
  background: boolean;
}
export type Script = AndOrList[];

type Token = { type: 'word'; word: Word; raw: string } | { type: 'op'; op: string };

export class ShellSyntaxError extends Error {
  /** The input ended inside a quote or after `|`/`&&`: an interactive shell asks for more. */
  constructor(message: string, readonly incomplete = false) {
    super(message);
  }
}

const OPERATORS = ['2>&1', '>&2', '2>>', '&&', '||', '>>', '2>', '&>', '|', '&', ';', '>', '<', '\n'];
const SPECIAL_VARS = /^[?$#@*!0-9]/;

/** Find the `)` closing a `$(` at `start` (just after the paren), honouring quotes and nesting. */
function matchParen(input: string, start: number): number {
  let depth = 1;
  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (ch === '\\') i++;
    else if (ch === "'") i = input.indexOf("'", i + 1) < 0 ? input.length : input.indexOf("'", i + 1);
    else if (ch === '"') {
      for (i++; i < input.length && input[i] !== '"'; i++) if (input[i] === '\\') i++;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  throw new ShellSyntaxError('unexpected end of input: missing )', true);
}

/** Parse `$…` at `i` (pointing at `$`); returns the segment and the index after it. */
function readDollar(input: string, i: number, quoted: boolean): [Segment, number] {
  const next = input[i + 1];
  if (next === '(') {
    const end = matchParen(input, i + 2);
    return [{ kind: 'cmd', source: input.slice(i + 2, end), quoted }, end + 1];
  }
  if (next === '{') {
    const end = input.indexOf('}', i + 2);
    if (end < 0) throw new ShellSyntaxError('unexpected end of input: missing }', true);
    const body = input.slice(i + 2, end);
    const m = /^([A-Za-z_][\w]*|[?$#@*!0-9])(?:(:-|-|:=|:\+)(.*))?$/s.exec(body);
    if (!m) throw new ShellSyntaxError(`bad substitution: \${${body}}`);
    const seg: Segment = { kind: 'var', name: m[1]!, quoted };
    if (m[2]) {
      seg.op = m[2] as ':-';
      seg.arg = tokenizeWord(m[3] ?? '', quoted);
    }
    return [seg, end + 1];
  }
  if (next && SPECIAL_VARS.test(next)) return [{ kind: 'var', name: next, quoted }, i + 2];
  const m = /^[A-Za-z_]\w*/.exec(input.slice(i + 1));
  if (!m) return [{ kind: 'text', value: '$', quoted }, i + 1];
  return [{ kind: 'var', name: m[0], quoted }, i + 1 + m[0].length];
}

/** Segments of a word body (used for `${x:-default}` arguments). */
function tokenizeWord(text: string, quoted: boolean): Word {
  const tokens = tokenize(text, true);
  const word: Word = [];
  for (const t of tokens) if (t.type === 'word') word.push(...t.word.map((s) => (s.kind === 'tilde' ? s : { ...s, quoted: quoted || ('quoted' in s && s.quoted) } as Segment)));
  return word;
}

export function tokenize(input: string, wordOnly = false): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\\' && input[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (!wordOnly) {
      const op = OPERATORS.find((o) => input.startsWith(o, i));
      if (op) {
        tokens.push({ type: 'op', op });
        i += op.length;
        continue;
      }
    }
    // A word: runs until unquoted whitespace or an operator character.
    const word: Word = [];
    const start = i;
    let text = '';
    const flush = () => {
      if (text) word.push({ kind: 'text', value: text, quoted: false });
      text = '';
    };
    if (input[i] === '~' && (i + 1 >= input.length || /[\s/;|&<>]/.test(input[i + 1]!))) {
      word.push({ kind: 'tilde' });
      i++;
    }
    while (i < input.length) {
      const c = input[i]!;
      if (/[\s]/.test(c) && !wordOnly) break;
      if (!wordOnly && /[;|&<>]/.test(c)) break;
      if (c === '\\') {
        text += input[i + 1] ?? '';
        i += 2;
      } else if (c === "'") {
        const end = input.indexOf("'", i + 1);
        if (end < 0) throw new ShellSyntaxError('unexpected end of input: unterminated quote', true);
        flush();
        word.push({ kind: 'text', value: input.slice(i + 1, end), quoted: true });
        i = end + 1;
      } else if (c === '"') {
        flush();
        i++;
        let inner = '';
        const pushInner = () => {
          if (inner) word.push({ kind: 'text', value: inner, quoted: true });
          inner = '';
        };
        let closed = false;
        while (i < input.length) {
          const d = input[i]!;
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === '\\' && /["\\$`\n]/.test(input[i + 1] ?? '')) {
            inner += input[i + 1];
            i += 2;
          } else if (d === '$') {
            pushInner();
            const [seg, next] = readDollar(input, i, true);
            word.push(seg);
            i = next;
          } else if (d === '`') {
            pushInner();
            const end = input.indexOf('`', i + 1);
            if (end < 0) throw new ShellSyntaxError('unexpected end of input: unterminated `', true);
            word.push({ kind: 'cmd', source: input.slice(i + 1, end), quoted: true });
            i = end + 1;
          } else {
            inner += d;
            i++;
          }
        }
        if (!closed) throw new ShellSyntaxError('unexpected end of input: unterminated quote', true);
        pushInner();
        if (!word.length || word[word.length - 1]!.kind !== 'text') word.push({ kind: 'text', value: '', quoted: true });
      } else if (c === '$') {
        flush();
        const [seg, next] = readDollar(input, i, false);
        word.push(seg);
        i = next;
      } else if (c === '`') {
        flush();
        const end = input.indexOf('`', i + 1);
        if (end < 0) throw new ShellSyntaxError('unexpected end of input: unterminated `', true);
        word.push({ kind: 'cmd', source: input.slice(i + 1, end), quoted: false });
        i = end + 1;
      } else {
        text += c;
        i++;
      }
    }
    flush();
    tokens.push({ type: 'word', word, raw: input.slice(start, i) });
  }
  return tokens;
}

const ASSIGNMENT = /^([A-Za-z_]\w*)=/;
const REDIRECTS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '2>&1', '>&2']);

export function parse(input: string): Script {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (op: string) => {
    const t = tokens[pos];
    return t?.type === 'op' && t.op === op;
  };

  const command = (): Command => {
    const cmd: Command = { assignments: [], words: [], redirects: [] };
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.type === 'op') {
        if (!REDIRECTS.has(t.op)) break;
        pos++;
        if (t.op === '2>&1' || t.op === '>&2') {
          cmd.redirects.push({ op: t.op });
          continue;
        }
        const target = peek();
        if (target?.type !== 'word') throw new ShellSyntaxError(`syntax error near unexpected token \`${target?.type === 'op' ? target.op.replace('\n', 'newline') : 'newline'}'`);
        pos++;
        cmd.redirects.push({ op: t.op as RedirectOp, target: target.word });
        continue;
      }
      pos++;
      const first = t.word[0];
      const m = !cmd.words.length && first?.kind === 'text' && !first.quoted ? ASSIGNMENT.exec(first.value) : null;
      if (m) {
        const rest = first!.kind === 'text' ? first!.value.slice(m[0].length) : '';
        cmd.assignments.push({ name: m[1]!, value: [...(rest ? [{ kind: 'text', value: rest, quoted: false } as Segment] : []), ...t.word.slice(1)] });
      } else cmd.words.push(t.word);
    }
    return cmd;
  };

  const pipeline = (): Pipeline => {
    let negate = false;
    const t = peek();
    if (t?.type === 'word' && t.raw === '!') {
      negate = true;
      pos++;
    }
    const commands = [command()];
    while (isOp('|')) {
      pos++;
      while (isOp('\n')) pos++;
      if (!peek()) throw new ShellSyntaxError('unexpected end of input after |', true);
      commands.push(command());
    }
    for (const c of commands) if (!c.words.length && !c.assignments.length && !c.redirects.length) throw new ShellSyntaxError('syntax error near unexpected token `|\'');
    return { negate, commands };
  };

  const script: Script = [];
  while (pos < tokens.length) {
    if (isOp(';') || isOp('\n')) {
      pos++;
      continue;
    }
    const t = peek()!;
    if (t.type === 'op' && !REDIRECTS.has(t.op)) throw new ShellSyntaxError(`syntax error near unexpected token \`${t.op}'`);
    const list: AndOrList = { first: pipeline(), rest: [], background: false };
    while (isOp('&&') || isOp('||')) {
      const op = (tokens[pos] as { op: '&&' | '||' }).op;
      pos++;
      while (isOp('\n')) pos++;
      if (!peek()) throw new ShellSyntaxError(`unexpected end of input after ${op}`, true);
      list.rest.push({ op, pipeline: pipeline() });
    }
    if (isOp('&')) {
      list.background = true;
      pos++;
    }
    script.push(list);
  }
  return script;
}
