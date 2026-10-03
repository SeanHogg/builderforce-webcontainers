/**
 * ES modules → the CommonJS wrapper, so `require` and `import` share one
 * synchronous loader (`require()` must be sync, and esbuild-wasm has no sync
 * transform in the browser). es-module-lexer finds every import/export; this
 * file rewrites just those spans:
 *
 *   import d, { a as b } from 'x'   →  const __bfwc_m0 = __bfwc_import("x"); const d = …default; const { a: b } = …
 *   export const x = 1              →  const x = 1          (+ a live getter `x` on exports)
 *   export default expr             →  const __bfwc_default = expr
 *   export { a as b } / export * from 'y' / import('z') / import.meta
 *
 * Exports are LIVE (getters over the local bindings). Imported bindings are
 * snapshots taken when the import statement runs: a cycle that reads a binding
 * before the other module finished initialising sees `undefined` rather than
 * the later value. Function declarations are hoisted and exported before any
 * import runs, which covers the common cyclic case.
 */
import { init, parse } from 'es-module-lexer';

/** Resolve before the first transform (the lexer is WebAssembly). */
export const esmReady: Promise<void> = init;

export const ESM_MARK = Symbol.for('bfwc.esm');

interface Edit {
  start: number;
  end: number;
  text: string;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

/** Cheap pre-check before lexing a CommonJS-looking file. */
export function mayBeEsm(source: string): boolean {
  return /(?:^|[\s;})])(?:import\s*[\w{*'"]|export\s+|export\s*[{*])/.test(source);
}

/** Does the lexer see module syntax? (Node's "detect module" for ambiguous .js) */
export function hasModuleSyntax(source: string): boolean {
  try {
    const [imports, exports] = parse(source);
    return exports.length > 0 || imports.some((i) => i.t === 1 || i.t === 3);
  } catch {
    return false;
  }
}

/** `a, b as c, default as d` → [[imported, local]]. */
function parseList(list: string): Array<[string, string]> {
  return list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = /^(?:type\s+)?("[^"]*"|'[^']*'|[^\s]+)(?:\s+as\s+("[^"]*"|'[^']*'|[^\s]+))?$/.exec(part);
      if (!m) throw new SyntaxError(`Cannot parse import/export list entry "${part}"`);
      const unquote = (s: string) => (/^["']/.test(s) ? s.slice(1, -1) : s);
      return [unquote(m[1]!), unquote(m[2] ?? m[1]!)] as [string, string];
    });
}

const access = (ns: string, key: string) => (IDENT.test(key) ? `${ns}.${key}` : `${ns}[${JSON.stringify(key)}]`);

/** After `const`/`let`/`var`, the further declarator names `export const a = 1, b = 2` declares. */
function extraDeclarators(source: string, from: number): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i++; i < source.length && source[i] !== quote; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === ';') break;
    else if (depth === 0 && ch === '\n') {
      const before = source.slice(from, i).trimEnd();
      const after = source.slice(i + 1).trimStart();
      if (!/[,=+\-*/%&|^?:(]$/.test(before) && !/^[,.=+\-*/%&|^?:)]/.test(after)) break;
    } else if (depth === 0 && ch === ',') {
      const m = /^\s*([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(source.slice(i + 1));
      if (m) names.push(m[1]!);
    }
    if (depth < 0) break;
  }
  return names;
}

const isIdentChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_$]/u.test(ch);

/** The `export` keyword governing the export name at `pos` (not a substring of an identifier). */
function exportKeywordBefore(source: string, pos: number): number {
  for (let at = source.lastIndexOf('export', pos - 1); at >= 0; at = source.lastIndexOf('export', at - 1)) {
    if (!isIdentChar(source[at - 1]) && !isIdentChar(source[at + 6])) return at;
  }
  return -1;
}

export function esmToCjs(source: string): string {
  const [imports, exports] = parse(source);
  const edits: Edit[] = [];
  const getters = new Map<string, string>();
  const removedKeywords = new Set<number>();
  const reexportStarts = new Set<number>();
  let counter = 0;
  const call = (spec: string) => `__bfwc_import(${JSON.stringify(spec)})`;

  for (const imp of imports) {
    if (imp.t === 2) {
      edits.push({ start: imp.ss, end: imp.d, text: '__bfwc_dynamic' });
      continue;
    }
    if (imp.t === 3) {
      edits.push({ start: imp.s, end: imp.e, text: '__bfwc_meta' });
      continue;
    }
    if (imp.t !== 1 || imp.n === undefined) continue;
    const statement = source.slice(imp.ss, imp.se);
    const ns = `__bfwc_m${counter++}`;
    const load = `const ${ns} = ${call(imp.n)};`;

    if (statement.startsWith('export')) {
      reexportStarts.add(imp.ss);
      const nsMatch = /^export\s*\*\s*as\s+("[^"]*"|'[^']*'|[^\s]+)/.exec(statement);
      if (nsMatch) getters.set(nsMatch[1]!.replace(/^["']|["']$/g, ''), ns);
      else if (/^export\s*\*/.test(statement)) edits.push({ start: imp.ss, end: imp.se, text: `${load} __bfwc_star(exports, ${ns});` });
      else for (const [imported, exported] of parseList(/\{([^}]*)\}/.exec(statement)?.[1] ?? '')) getters.set(exported, access(ns, imported));
      if (!edits.some((e) => e.start === imp.ss)) edits.push({ start: imp.ss, end: imp.se, text: load });
      continue;
    }

    const clause = /^import\s*([\s\S]*?)\s*from\s*["']/.exec(statement)?.[1];
    if (clause === undefined) {
      edits.push({ start: imp.ss, end: imp.se, text: `${call(imp.n)};` });
      continue;
    }
    const parts: string[] = [load];
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const outside = clause.replace(/\{[\s\S]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const item of outside) {
      const star = /^\*\s*as\s+(\S+)$/.exec(item);
      if (star) parts.push(`const ${star[1]} = ${ns};`);
      else parts.push(`const ${item} = __bfwc_get(${ns}, "default");`);
    }
    if (braces) {
      for (const [imported, local] of parseList(braces[1]!)) parts.push(`const ${local} = __bfwc_get(${ns}, ${JSON.stringify(imported)});`);
    }
    edits.push({ start: imp.ss, end: imp.se, text: parts.join(' ') });
  }

  const listStatements = new Map<number, number>();
  for (const exp of exports) {
    const kw = exportKeywordBefore(source, exp.s);
    if (kw < 0 || reexportStarts.has(kw)) continue;
    const between = source.slice(kw + 6, exp.s);
    if (/^\s*\{/.test(between)) {
      // `export { a, b as c }`: drop the statement, keep the bindings as getters.
      if (!listStatements.has(kw)) {
        const close = source.indexOf('}', kw);
        let end = close + 1;
        const semi = /^\s*;/.exec(source.slice(end));
        if (semi) end += semi[0].length;
        listStatements.set(kw, end);
        edits.push({ start: kw, end, text: '' });
      }
      getters.set(exp.n, exp.ln ?? exp.n);
      continue;
    }
    if (exp.n === 'default' && source.startsWith('default', exp.s) && !between.trim()) {
      if (exp.ln && exp.ls >= 0) {
        edits.push({ start: kw, end: exp.e, text: '' }); // `export default function name` → `function name`
        getters.set('default', exp.ln);
      } else {
        edits.push({ start: kw, end: exp.e, text: 'const __bfwc_default =' });
        getters.set('default', '__bfwc_default');
      }
      continue;
    }
    if (!removedKeywords.has(kw)) {
      removedKeywords.add(kw);
      edits.push({ start: kw, end: kw + 6, text: '' });
      const decl = /^\s*(const|let|var)\b/.exec(between);
      if (decl) for (const name of extraDeclarators(source, exp.e)) getters.set(name, name);
    }
    getters.set(exp.n, exp.ln ?? exp.n);
  }

  edits.sort((a, b) => b.start - a.start);
  let code = source;
  for (const edit of edits) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  const getterList = [...getters].map(([name, expr]) => `${JSON.stringify(name)}: () => ${expr}`).join(', ');
  // One line, so stack-trace line numbers stay aligned with the source.
  return `"use strict";__bfwc_esm(exports, { ${getterList} });${code}`;
}
