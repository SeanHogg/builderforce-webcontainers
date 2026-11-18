/**
 * Arrow functions in Angular template expressions. The Angular CLI's AOT
 * compiler and this runtime's template compiler reject `=>` inside bindings, so
 * the check flags them before the run. Only expression contexts are scanned:
 * `{{ … }}` interpolations, `[x]` / `(x)` / `[(x)]` / `*ngX` attribute values and
 * `@if` / `@else if` / `@for` / `@switch` / `@case` block parameters and `@let`
 * declarations — an arrow
 * in plain template text is just text. HTML comments are skipped.
 */
import { skipString } from '../angular/scanner.js';

const INTERPOLATION = /\{\{([\s\S]*?)\}\}/g;
/** A binding attribute up to its opening quote (possibly escaped, inside a TS string). */
const BINDING = /(?:^|[\s"'])(?:\[\(?[^\]\s=]+\)?\]|\([^)\s=]+\)|\*[\w.:-]+)\s*=\s*\\?(["'])/g;
const BLOCK = /@(?:if|else\s+if|for|switch|case)\s*\(/g;
/** `@let name = <expression>;` (Angular 18.1+). */
const LET = /@let\s+[A-Za-z_$][\w$]*\s*=/g;

/** Template text with `<!-- … -->` blanked, offsets kept. */
function blankHtmlComments(template: string): string {
  return template.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** The end of a parenthesised block parameter opened just before `start`, quotes respected. */
function closingParen(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') i = skipString(text, i);
    else {
      if (char === '(') depth++;
      else if (char === ')' && --depth === 0) return i;
      i++;
    }
  }
  return text.length;
}

/** The `;` ending an `@let` declaration's expression that starts at `start`, quotes respected. */
function statementEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') i = skipString(text, i);
    else if (char === ';') return i;
    else i++;
  }
  return text.length;
}

/** Offsets of `=>` in `text[start, end)` that are not inside a string literal. */
function arrowsIn(text: string, start: number, end: number, into: Set<number>): void {
  let i = start;
  while (i < end - 1) {
    const char = text[i];
    if (char === '"' || char === "'" || char === '`') i = skipString(text, i);
    else {
      if (char === '=' && text[i + 1] === '>') into.add(i);
      i++;
    }
  }
}

/** Offsets (into `template`) of every arrow function in a template expression, ascending. */
export function templateArrowOffsets(template: string): number[] {
  const text = blankHtmlComments(template);
  const found = new Set<number>();
  for (const match of text.matchAll(INTERPOLATION)) {
    const start = match.index + 2;
    arrowsIn(text, start, start + match[1]!.length, found);
  }
  for (const match of text.matchAll(BINDING)) {
    const start = match.index + match[0].length;
    const close = text.indexOf(match[1]!, start);
    let end = close === -1 ? text.length : close;
    if (text[end - 1] === '\\') end--;
    arrowsIn(text, start, end, found);
  }
  for (const match of text.matchAll(BLOCK)) {
    const start = match.index + match[0].length;
    arrowsIn(text, start, closingParen(text, start), found);
  }
  for (const match of text.matchAll(LET)) {
    const start = match.index + match[0].length;
    arrowsIn(text, start, statementEnd(text, start), found);
  }
  return [...found].sort((a, b) => a - b);
}
