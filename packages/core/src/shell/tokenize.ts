/**
 * Shell tokens: words (with their quoting, as segments) and operators. Here-
 * documents are read here too — `<<EOF` is followed, after the end of its line,
 * by body lines up to the delimiter — so the parser sees each body attached to
 * its redirect.
 */
import type { Segment, Word } from './ast.js';

export type Token =
  | { type: 'word'; word: Word; raw: string }
  | { type: 'op'; op: string }
  | { type: 'heredoc'; body?: Word };

export class ShellSyntaxError extends Error {
  /** The input ended inside a quote, a block or a here-document: an interactive shell asks for more. */
  constructor(message: string, readonly incomplete = false) {
    super(message);
  }
}

const OPERATORS = ['2>&1', '>&2', '2>>', '<<-', '&&', '||', ';;', '>>', '<<', '2>', '&>', '|', '&', ';', '>', '<', '(', ')', '\n'];
const SPECIAL_VARS = /^[?$#@*!0-9]/;
/** Unquoted characters that end a word. */
const WORD_BREAK = /[;|&<>()]/;

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

/** A here-document body as a word: `$VAR`, `$(…)` and backticks expand, nothing splits or globs. */
function heredocWord(body: string): Word {
  const word: Word = [];
  let text = '';
  const flush = () => {
    if (text) word.push({ kind: 'text', value: text, quoted: true });
    text = '';
  };
  for (let i = 0; i < body.length;) {
    const c = body[i]!;
    if (c === '\\' && /[$`\\\n]/.test(body[i + 1] ?? '')) {
      if (body[i + 1] !== '\n') text += body[i + 1];
      i += 2;
    } else if (c === '$') {
      flush();
      const [seg, next] = readDollar(body, i, true);
      word.push(seg);
      i = next;
    } else if (c === '`') {
      flush();
      const end = body.indexOf('`', i + 1);
      if (end < 0) throw new ShellSyntaxError('unterminated ` in here-document');
      word.push({ kind: 'cmd', source: body.slice(i + 1, end), quoted: true });
      i = end + 1;
    } else {
      text += c;
      i++;
    }
  }
  flush();
  return word.length ? word : [{ kind: 'text', value: '', quoted: true }];
}

interface PendingHeredoc {
  token: { type: 'heredoc'; body?: Word };
  delimiter: string;
  strip: boolean;
  quoted: boolean;
}

/** Read the bodies of pending here-documents starting at `i` (the start of a line); returns the index after them. */
function readHeredocs(input: string, i: number, pending: PendingHeredoc[]): number {
  for (const doc of pending) {
    const lines: string[] = [];
    for (;;) {
      if (i >= input.length) throw new ShellSyntaxError(`unexpected end of input: here-document delimited by ${doc.delimiter}`, true);
      const end = input.indexOf('\n', i);
      let line = input.slice(i, end < 0 ? input.length : end).replace(/\r$/, '');
      i = end < 0 ? input.length : end + 1;
      if (doc.strip) line = line.replace(/^\t+/, '');
      if (line === doc.delimiter) break;
      if (end < 0) throw new ShellSyntaxError(`unexpected end of input: here-document delimited by ${doc.delimiter}`, true);
      lines.push(line);
    }
    const body = lines.map((l) => l + '\n').join('');
    doc.token.body = doc.quoted ? [{ kind: 'text', value: body, quoted: true }] : heredocWord(body);
  }
  pending.length = 0;
  return i;
}

export function tokenize(input: string, wordOnly = false): Token[] {
  const tokens: Token[] = [];
  const pending: PendingHeredoc[] = [];
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
        if (op === '\n' && pending.length) i = readHeredocs(input, i, pending);
        if (op === '<<' || op === '<<-') {
          while (input[i] === ' ' || input[i] === '\t') i++;
          const start = i;
          while (i < input.length && !/[\s;|&<>()]/.test(input[i]!)) i++;
          const raw = input.slice(start, i);
          if (!raw) throw new ShellSyntaxError('syntax error: here-document needs a delimiter');
          const token: PendingHeredoc['token'] = { type: 'heredoc' };
          tokens.push(token);
          pending.push({ token, delimiter: raw.replace(/["'\\]/g, ''), strip: op === '<<-', quoted: /["'\\]/.test(raw) });
        }
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
    if (input[i] === '~' && (i + 1 >= input.length || /[\s/;|&<>()]/.test(input[i + 1]!))) {
      word.push({ kind: 'tilde' });
      i++;
    }
    while (i < input.length) {
      const c = input[i]!;
      if (/[\s]/.test(c) && !wordOnly) break;
      if (!wordOnly && WORD_BREAK.test(c)) break;
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
  if (pending.length) throw new ShellSyntaxError(`unexpected end of input: here-document delimited by ${pending[0]!.delimiter}`, true);
  return tokens;
}
