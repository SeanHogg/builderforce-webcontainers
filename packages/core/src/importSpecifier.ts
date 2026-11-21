/**
 * An import's specifier, without `eval`.
 *
 * es-module-lexer decodes each string specifier (`n`) with an indirect `eval` of
 * the literal, and leaves `n` undefined when that throws. Under a Content Security
 * Policy without `'unsafe-eval'` — the local launcher's host page, any embedder
 * that keeps eval off — it ALWAYS throws, so every specifier came back undefined
 * and the dev server served modules with their bare imports (`react`,
 * `react/jsx-runtime`) untouched: the browser refused them and the preview stayed
 * blank. This decodes the literal itself, so the result is the same with or
 * without eval.
 */

/** The lexer's import record, as far as this needs it. */
export interface LexedImport {
  /** The decoded specifier; undefined when the lexer could not decode it (or it is not a string). */
  n?: string;
  /** Specifier start/end. A static import's span is inside the quotes; a dynamic import's is the whole argument. */
  s: number;
  e: number;
  /** -1 static, -2 `import.meta`, ≥0 dynamic. */
  d: number;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };

function hexCode(text: string): number | undefined {
  return /^[0-9a-fA-F]+$/.test(text) ? parseInt(text, 16) : undefined;
}

/**
 * A JavaScript string literal's value (`'a\'b'` → `a'b`), or undefined when `literal`
 * is not exactly one single- or double-quoted string literal (`'a' + 'b'`, a template,
 * an identifier) or holds an invalid escape.
 */
export function decodeStringLiteral(literal: string): string | undefined {
  const quote = literal[0];
  if ((quote !== '"' && quote !== "'") || literal.length < 2 || literal[literal.length - 1] !== quote) return undefined;
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === quote || char === '\n' || char === '\r') return undefined; // the literal ended early: not ONE literal
    if (char !== '\\') {
      out += char;
      continue;
    }
    const next = body[++i];
    if (next === undefined) return undefined;
    if (next === '\r') {
      if (body[i + 1] === '\n') i++; // a line continuation
      continue;
    }
    if (next === '\n' || next === '\u2028' || next === '\u2029') continue;
    if (next === '0' && /[0-9]/.test(body[i + 1] ?? '')) return undefined; // a legacy octal escape
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
    } else if (next === 'x') {
      const code = hexCode(body.slice(i + 1, i + 3));
      if (code === undefined || body.slice(i + 1, i + 3).length !== 2) return undefined;
      out += String.fromCharCode(code);
      i += 2;
    } else if (next === 'u') {
      let digits: string;
      if (body[i + 1] === '{') {
        const close = body.indexOf('}', i + 2);
        if (close < 0) return undefined;
        digits = body.slice(i + 2, close);
        i = close;
      } else {
        digits = body.slice(i + 1, i + 5);
        if (digits.length !== 4) return undefined;
        i += 4;
      }
      const code = hexCode(digits);
      if (code === undefined || code > 0x10ffff) return undefined;
      out += String.fromCodePoint(code);
    } else if (/[1-9]/.test(next)) {
      return undefined; // legacy octal: not in modules
    } else {
      out += next; // `\'`, `\"`, `\\` and identity escapes
    }
  }
  return out;
}

/**
 * The specifier of a static or dynamic import as es-module-lexer found it in
 * `source`: the lexer's `n` when it decoded one, else the literal decoded here.
 * Undefined for `import.meta` and for a dynamic import whose argument is not one
 * string literal (`import(name)`, `import('./' + x)`).
 */
export function importSpecifier(source: string, entry: LexedImport): string | undefined {
  if (entry.n !== undefined) return entry.n;
  if (entry.d === -2) return undefined;
  // A static import's span excludes its quotes; a dynamic import's is the argument itself.
  const literal = entry.d === -1 ? source.slice(entry.s - 1, entry.e + 1) : source.slice(entry.s, entry.e).trim();
  return decodeStringLiteral(literal);
}

/** The lexer's export record, as far as this needs it. */
export interface LexedExport {
  /** The exported name; undefined when the lexer could not decode a quoted one. */
  n?: string;
  /** The local name; undefined when there is none or the lexer could not decode a quoted one. */
  ln?: string;
  s: number;
  e: number;
  ls: number;
  le: number;
}

/** A name span as written: a quoted string-literal name decoded, an identifier as is. */
function nameAt(source: string, start: number, end: number): string | undefined {
  const text = source.slice(start, end);
  return text[0] === '"' || text[0] === "'" ? decodeStringLiteral(text) : text;
}

/**
 * Export records with their names decoded without `eval`: the lexer decodes a
 * string-literal name (`export { x as "a-b" }`) with `eval` too, and leaves it
 * undefined under a CSP that forbids it.
 */
export function exportNames<T extends LexedExport>(source: string, exports: readonly T[]): T[] {
  return exports.map((entry) => ({
    ...entry,
    n: entry.n ?? nameAt(source, entry.s, entry.e),
    ln: entry.ln ?? (entry.ls >= 0 ? nameAt(source, entry.ls, entry.le) : undefined),
  }));
}
