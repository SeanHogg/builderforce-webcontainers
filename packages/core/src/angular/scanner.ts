/**
 * The one TS-aware lexer the Angular source transforms share. It does not parse
 * TypeScript: it MASKS a file — every string, template literal, comment and
 * regex literal blanked to spaces (newlines kept, delimiters kept), so offsets
 * still line up with the original — and the transforms then find decorators,
 * classes and brackets with plain searches over code that can no longer contain
 * a stray `{`, `)` or `@Component(` inside a string or an inline template.
 */

const IDENT = /[\w$]|[^\x00-\x7f]/;
/** After one of these (or a keyword below), a `/` starts a regex literal, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);

const blankOf = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * The last significant character or word before `end` in the masked output.
 * `++` / `--` come back whole: after a postfix increment (`i++ / x`) a `/` divides.
 */
function precedingToken(out: string): string {
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i]!)) i--;
  if (i < 0) return '';
  if ((out[i] === '+' || out[i] === '-') && out[i - 1] === out[i]) return out[i]! + out[i];
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
 * Index just past the string or template literal opening at `start` (`'`, `"` or
 * a backtick, `${…}` followed). An unterminated `'…'` / `"…"` ends at its line.
 */
export function skipString(src: string, start: number): number {
  return src[start] === '`' ? skipTemplate(src, start) : skipQuoted(src, start);
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
 * The bracket depth at each index of `masked[start, end)`, relative to `start`
 * (index `i` is at `[i - start]`), counted before the character at `i`: a `}`
 * closing a depth-0 block is at depth 1, the character after it at 0.
 */
export function bracketDepths(masked: string, start: number, end: number): Int32Array {
  const depthAt = new Int32Array(end - start + 1);
  let depth = 0;
  for (let i = start; i < end; i++) {
    depthAt[i - start] = depth;
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
  }
  depthAt[end - start] = depth;
  return depthAt;
}

/**
 * Every `regex` match in `masked[start, end)` that sits at bracket depth 0
 * relative to `start` (a class member, not code inside a method). `regex` must
 * be global.
 */
export function matchesAtDepthZero(masked: string, start: number, end: number, regex: RegExp): RegExpExecArray[] {
  const depthAt = bracketDepths(masked, start, end);
  const body = masked.slice(0, end);
  const out: RegExpExecArray[] = [];
  regex.lastIndex = start;
  for (let m = regex.exec(body); m; m = regex.exec(body)) {
    if (m.index >= start && depthAt[m.index - start] === 0) out.push(m);
    if (m[0].length === 0) regex.lastIndex++;
  }
  return out;
}
