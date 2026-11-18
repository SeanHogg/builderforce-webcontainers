import { matchBracket, skipSpace, splitTopLevel, trimRange, type Range } from './scanner.js';

/**
 * The few TypeScript shapes the Angular transforms look for — decorator calls,
 * the classes they decorate, object-literal properties, string literals — found
 * over code masked by {@link maskCode} (scanner.ts), plus how the transforms
 * apply their edits. Every offset is into the original source.
 */

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
    if (m.index > 0 && /[\w$]/.test(masked[m.index - 1]!)) continue;
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

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** The value of a string literal (`'x'`, `"x"`, or a template with no `${}`), or undefined. */
export function stringLiteralValue(text: string): string | undefined {
  const t = text.trim();
  const quote = t[0];
  if ((quote !== '"' && quote !== "'" && quote !== '`') || t.length < 2 || t[t.length - 1] !== quote) return undefined;
  const inner = t.slice(1, -1);
  if (quote === '`' && inner.includes('${')) return undefined;
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

/**
 * Apply non-overlapping edits (any order) to `source`. Insertions at the same
 * offset land in the order they are listed.
 */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  let out = source;
  const ordered = edits.map((edit, index) => ({ edit, index })).sort((a, b) => b.edit.start - a.edit.start || b.edit.end - a.edit.end || b.index - a.index);
  for (const { edit } of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** One property of an object literal. */
export interface ObjectProperty {
  /** The whole property, trimmed. */
  range: Range;
  /** The key, unquoted; undefined for spreads, methods and computed keys. */
  key?: string;
  /** The value, trimmed (absent for shorthand properties). */
  value?: Range;
}

/** An object literal `{…}` (indexes of its braces) split into its properties. */
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
