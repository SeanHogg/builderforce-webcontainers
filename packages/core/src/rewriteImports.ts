import { init, parse } from 'es-module-lexer';

/**
 * Rewrite every import specifier in an ES module — static `import`/`export … from`,
 * side-effect `import 'x'`, and string-literal dynamic `import('x')` — through
 * `map`. A `map` result of `undefined` leaves that specifier untouched, as are
 * non-literal dynamic imports and `import.meta`.
 *
 * Positions come from es-module-lexer rather than a regex, so specifiers inside
 * strings, comments and template literals are never touched.
 */
export async function rewriteImports(code: string, map: (specifier: string) => string | undefined): Promise<string> {
  await init;
  const [imports] = parse(code);
  let out = '';
  let cursor = 0;
  for (const entry of imports) {
    if (entry.d === -2 || entry.n === undefined) continue; // import.meta, or a non-literal dynamic import
    const replacement = map(entry.n);
    if (replacement === undefined || replacement === entry.n) continue;
    const dynamic = entry.d > -1;
    out += code.slice(cursor, entry.s) + (dynamic ? JSON.stringify(replacement) : replacement);
    cursor = entry.e;
  }
  return out + code.slice(cursor);
}
