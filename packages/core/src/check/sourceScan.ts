/**
 * Lightweight text scanning for the pre-run checks that do not use a compiler
 * (check/angular.ts). Offsets are preserved throughout, so a match in scanned
 * text is a position in the original file.
 */

/**
 * The source with `//` and `/* *\/` comments replaced by spaces (newlines kept),
 * string and template literals left intact — so a pattern found in the result
 * is code or a string, never a comment. Regex literals are not recognised.
 */
export function blankComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (char === '"' || char === "'" || char === '`') {
      const stop = stringEnd(source, i);
      out += source.slice(i, stop);
      i = stop;
    } else {
      out += char;
      i++;
    }
  }
  return out;
}

/**
 * The offset just past the string literal opening at `start` (its closing
 * quote, or the line end for an unterminated '…'/"…"). Escapes are skipped;
 * `${…}` inside a template literal is not followed.
 */
export function stringEnd(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') i += 2;
    else if (char === quote) return i + 1;
    else if (char === '\n' && quote !== '`') return i;
    else i++;
  }
  return source.length;
}

/** 1-based line and column of `offset`, like an editor's gutter. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}
