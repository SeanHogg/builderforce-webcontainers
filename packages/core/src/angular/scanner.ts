/**
 * The one TS-aware lexer the Angular source transforms share. It does not parse
 * TypeScript: it MASKS a file — every string, template literal, comment and
 * regex literal blanked to spaces (newlines kept, delimiters kept), so offsets
 * still line up with the original — and the transforms then find decorators,
 * classes and brackets with plain searches over code that can no longer contain
 * a stray `{`, `)` or `@Component(` inside a string or an inline template.
 */

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;
/** After one of these (or a keyword below), a `/` starts a regex literal, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

const blankOf = (text: string): string => text.replace(/[^\n]/g, ' ');

/** The last significant character or word before `end` in the masked output. */
function precedingToken(out: string): string {
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i]!)) i--;
  if (i < 0) return '';
  if (!IDENT.test(out[i]!)) return out[i]!;
  let start = i;
  while (start > 0 && IDENT.test(out[start - 1]!)) start--;
  return out.slice(start, i + 1);
}

/** Index just past a quoted string starting at `start`. */
function skipQuoted(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length && src[i] !== quote && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, src.length);
}

/** Index just past a template literal starting at `start`, `${…}` (with nested literals) included. */
function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i + 1;
    if (ch === '$' && src[i + 1] === '{') {
      i = skipCode(src, i + 2, '}');
      continue;
    }
    i++;
  }
  return i;
}

/** Index just past code starting at `start` that ends at an unmatched `close`. */
function skipCode(src: string, start: number, close: string): number {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const next = skipNonCode(src, i, '');
    if (next !== i) { i = next; continue; }
    const ch = src[i]!;
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      if (depth === 0 && ch === close) return i + 1;
      depth--;
    }
    i++;
  }
  return i;
}

/** Index just past a regex literal starting at `start`. */
function skipRegex(src: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < src.length && src[i] !== '\n') {
    const ch = src[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) { i++; break; }
    i++;
  }
  while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
  return i;
}

/**
 * When `src[i]` opens a string, template, comment or regex, the index just past
 * it; otherwise `i`. `before` is the code preceding `i` (decides regex vs `/`).
 */
function skipNonCode(src: string, i: number, before: string): number {
  const ch = src[i];
  const next = src[i + 1];
  if (ch === '"' || ch === "'") return skipQuoted(src, i);
  if (ch === '`') return skipTemplate(src, i);
  if (ch === '/' && next === '/') {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end;
  }
  if (ch === '/' && next === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  if (ch === '/' && before !== '') {
    const token = precedingToken(before);
    if (REGEX_AFTER.has(token) || REGEX_KEYWORDS.has(token)) return skipRegex(src, i);
  }
  return i;
}

/**
 * `source` with every string, template literal, comment and regex blanked: the
 * delimiters of strings and templates stay (so a literal is still visible as a
 * literal), their contents become spaces, newlines are kept. Same length.
 */
export function maskCode(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    // At the very start a `/` can only be a comment or a regex; `\n` stands in for "start".
    const end = skipNonCode(source, i, out || '\n');
    if (end === i) { out += source[i]; i++; continue; }
    const literal = source.slice(i, end);
    const ch = literal[0]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const closed = literal.length > 1 && literal[literal.length - 1] === ch;
      out += ch + blankOf(literal.slice(1, closed ? -1 : undefined)) + (closed ? ch : '');
    } else {
      out += blankOf(literal);
    }
    i = end;
  }
  return out;
}

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/**
 * The index of the bracket closing the one at `open`, in masked code. Angle
 * brackets are matched by count (type arguments), ignoring the `>` of `=>`.
 * -1 when unbalanced.
 */
export function matchBracket(masked: string, open: number): number {
  const opener = masked[open]!;
  const closer = OPEN[opener];
  if (!closer) return -1;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i]!;
    if (opener === '<') {
      if (ch === '<') depth++;
      else if (ch === '>' && masked[i - 1] !== '=') depth--;
      else if (ch === '(' || ch === '[' || ch === '{') { const end = matchBracket(masked, i); if (end < 0) return -1; i = end; continue; }
      else if (ch === ';') return -1;
    } else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0) return i;
  }
  return -1;
}

export interface Range {
  start: number;
  end: number;
}

/**
 * Split `masked[start, end)` at top-level commas; with `angles`, commas inside
 * `<…>` type arguments are not top-level either. Empty trailing parts are dropped.
 */
export function splitTopLevel(masked: string, start: number, end: number, options: { angles?: boolean } = {}): Range[] {
  const parts: Range[] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{' || (options.angles && ch === '<')) depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (options.angles && ch === '>' && masked[i - 1] !== '=')) depth--;
    else if (ch === ',' && depth === 0) {
      parts.push({ start: from, end: i });
      from = i + 1;
    }
  }
  if (masked.slice(from, end).trim()) parts.push({ start: from, end });
  return parts;
}

/** The first index at or after `i` that is not whitespace. */
export function skipSpace(masked: string, i: number): number {
  while (i < masked.length && /\s/.test(masked[i]!)) i++;
  return i;
}

/** Trimmed bounds of a range. */
export function trimRange(masked: string, range: Range): Range {
  let { start, end } = range;
  while (start < end && /\s/.test(masked[start]!)) start++;
  while (end > start && /\s/.test(masked[end - 1]!)) end--;
  return { start, end };
}

/**
 * Every `regex` match in `masked[start, end)` that sits at bracket depth 0
 * relative to `start` (a class member, not code inside a method). `regex` must
 * be global.
 */
export function matchesAtDepthZero(masked: string, start: number, end: number, regex: RegExp): RegExpExecArray[] {
  const depthAt = new Int32Array(end - start + 1);
  let depth = 0;
  for (let i = start; i < end; i++) {
    depthAt[i - start] = depth;
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  const body = masked.slice(0, end);
  const out: RegExpExecArray[] = [];
  regex.lastIndex = start;
  for (let m = regex.exec(body); m; m = regex.exec(body)) {
    if (m.index >= start && depthAt[m.index - start] === 0) out.push(m);
    if (m[0].length === 0) regex.lastIndex++;
  }
  return out;
}

export interface DecoratorCall {
  name: string;
  /** Index of the `@`. */
  start: number;
  /** Index of the call's `(` and `)`. */
  open: number;
  close: number;
}

/** Every `@Name(…)` call of one of `names`, in source order. */
export function findDecoratorCalls(masked: string, names: readonly string[]): DecoratorCall[] {
  const regex = new RegExp(`@\\s*(${names.join('|')})\\s*\\(`, 'g');
  const out: DecoratorCall[] = [];
  for (const m of masked.matchAll(regex)) {
    if (m.index > 0 && IDENT.test(masked[m.index - 1]!)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close > 0) out.push({ name: m[1]!, start: m.index, open, close });
  }
  return out;
}

export interface DecoratedClass {
  decorator: DecoratorCall;
  name: string;
  /** Indexes of the class body's `{` and `}`. */
  bodyOpen: number;
  bodyClose: number;
}

/**
 * Classes carrying one of the `names` decorators. From each decorator, other
 * decorators and `export`/`default`/`abstract` are skipped to reach `class`.
 */
export function findDecoratedClasses(masked: string, names: readonly string[]): DecoratedClass[] {
  const out: DecoratedClass[] = [];
  const seen = new Set<number>();
  for (const decorator of findDecoratorCalls(masked, names)) {
    let i = skipSpace(masked, decorator.close + 1);
    // Further decorators, then modifiers.
    for (;;) {
      if (masked[i] === '@') {
        const m = /^@\s*[\w$.]+\s*/.exec(masked.slice(i));
        if (!m) break;
        i = skipSpace(masked, i + m[0].length);
        if (masked[i] === '(') i = skipSpace(masked, matchBracket(masked, i) + 1);
        continue;
      }
      const word = /^(export|default|abstract|declare)\b\s*/.exec(masked.slice(i));
      if (!word) break;
      i += word[0].length;
    }
    const head = /^class\s+([A-Za-z_$][\w$]*)/.exec(masked.slice(i));
    if (!head) continue;
    i += head[0].length;
    // The body is the first `{` past the type parameters and heritage clauses.
    let bodyOpen = -1;
    while (i < masked.length) {
      const ch = masked[i]!;
      if (ch === '{') { bodyOpen = i; break; }
      if (ch === '(' || ch === '[' || ch === '<') {
        const end = matchBracket(masked, i);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      i++;
    }
    if (bodyOpen < 0 || seen.has(bodyOpen)) continue;
    const bodyClose = matchBracket(masked, bodyOpen);
    if (bodyClose < 0) continue;
    seen.add(bodyOpen);
    out.push({ decorator, name: head[1]!, bodyOpen, bodyClose });
  }
  return out;
}

/** The value of a string literal (`'x'`, `"x"`, or a template with no `${}`), or undefined. */
export function stringLiteralValue(text: string): string | undefined {
  const t = text.trim();
  const quote = t[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || t.length < 2 || t[t.length - 1] !== quote) return undefined;
  const inner = t.slice(1, -1);
  if (quote === '`' && inner.includes('${')) return undefined;
  const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return inner.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_m, esc: string) => {
    if (esc[0] === 'u' || esc[0] === 'x') return String.fromCodePoint(Number.parseInt(esc.replace(/^[ux]\{?|\}$/g, ''), 16));
    if (esc === '\n' || esc === '\r\n') return '';
    return ESCAPES[esc] ?? esc;
  });
}

export interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits (any order) to `source`. */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/** Splits an object literal `{…}` (indexes of its braces) into `key: value` properties. */
export interface ObjectProperty {
  /** The whole property, trimmed. */
  range: Range;
  /** The key, unquoted; undefined for spreads, methods and computed keys. */
  key?: string;
  /** The value, trimmed (absent for shorthand properties). */
  value?: Range;
}

export function objectProperties(source: string, masked: string, open: number, close: number): ObjectProperty[] {
  return splitTopLevel(masked, open + 1, close).map((raw) => {
    const range = trimRange(masked, raw);
    const text = masked.slice(range.start, range.end);
    const m = /^(?:([A-Za-z_$][\w$]*)|(["'])\s*\2)\s*:/.exec(text);
    if (!m) return { range };
    const key = m[1] ?? stringLiteralValue(source.slice(range.start, range.start + m[0].replace(/\s*:$/, '').length));
    const value = trimRange(masked, { start: range.start + m[0].length, end: range.end });
    return { range, key, value };
  });
}
