import { afterEach, describe, expect, it } from 'vitest';
import { decodeStringLiteral, importSpecifier } from '../src/importSpecifier.js';
import { rewriteImports } from '../src/rewriteImports.js';
import { esmReady, esmToCjs } from '../src/node/esm.js';

const realEval = globalThis.eval;

/** A page whose CSP has no `'unsafe-eval'`: every eval throws, as the browser's EvalError does. */
function forbidEval(): void {
  globalThis.eval = (() => {
    throw new EvalError("Evaluating a string as JavaScript violates the Content Security Policy directive because 'unsafe-eval' is not allowed");
  }) as typeof eval;
}

afterEach(() => {
  globalThis.eval = realEval;
});

describe('decodeStringLiteral', () => {
  it('decodes plain and escaped literals', () => {
    expect(decodeStringLiteral('"react"')).toBe('react');
    expect(decodeStringLiteral("'react/jsx-runtime'")).toBe('react/jsx-runtime');
    expect(decodeStringLiteral("'a\\'b'")).toBe("a'b");
    expect(decodeStringLiteral('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(decodeStringLiteral('"\\x41\\u0042\\u{1F600}\\n"')).toBe('AB\u{1F600}\n');
    expect(decodeStringLiteral('"a\\\nb"')).toBe('ab');
    expect(decodeStringLiteral('"a\\\r\nb\\ c\\ d"')).toBe('abcd');
  });

  it('refuses anything that is not exactly one literal', () => {
    expect(decodeStringLiteral("'a' + 'b'")).toBeUndefined();
    expect(decodeStringLiteral('`x`')).toBeUndefined();
    expect(decodeStringLiteral('name')).toBeUndefined();
    expect(decodeStringLiteral('"\\1"')).toBeUndefined();
    expect(decodeStringLiteral('"\\u12"')).toBeUndefined();
    expect(decodeStringLiteral('"')).toBeUndefined();
  });

  it('agrees with the language on what it decodes', () => {
    for (const literal of ['"x"', "'./a b.js'", '"\\t\\r\\v\\f\\b\\0"', "'\\q'", '"\\u00e9t\\u00e9"']) {
      expect(decodeStringLiteral(literal)).toBe(realEval(literal));
    }
  });
});

describe('importSpecifier', () => {
  it('prefers the lexer\'s own value and skips import.meta', () => {
    expect(importSpecifier('import "x"', { n: 'y', s: 8, e: 9, d: -1 })).toBe('y');
    expect(importSpecifier('import.meta.url', { s: 0, e: 11, d: -2 })).toBeUndefined();
  });
});

describe('regression: imports are rewritten under a CSP without unsafe-eval (blank launcher preview)', () => {
  const code = [
    'import { jsx } from "react/jsx-runtime";',
    "import React from 'react';",
    "export * from 'lib/escaped\\u002dname';",
    'const lazy = () => import("./page.js");',
    "const spaced = () => import( './spaced.js' );",
    "const joined = () => import('./a' + '.js');",
    'const dynamic = (name) => import(name);',
    'console.log(jsx, React, import.meta.url);',
  ].join('\n');

  it('maps every literal specifier — static, re-export, dynamic — with eval forbidden', async () => {
    forbidEval();
    const seen: string[] = [];
    const out = await rewriteImports(code, (specifier) => {
      seen.push(specifier);
      return `https://cdn.test/${specifier}`;
    });
    expect(seen).toEqual(['react/jsx-runtime', 'react', 'lib/escaped-name', './page.js', './spaced.js']);
    expect(out).toContain("import('./a' + '.js')");
    expect(out).toContain('from "https://cdn.test/react/jsx-runtime"');
    expect(out).toContain("from 'https://cdn.test/react'");
    expect(out).toContain('import("https://cdn.test/./page.js")');
    expect(out).toContain('import(name)');
    expect(out).toContain('import.meta.url');
  });

  it('gives the same output with eval allowed and forbidden', async () => {
    const map = (specifier: string) => `/m/${specifier}`;
    const allowed = await rewriteImports(code, map);
    forbidEval();
    expect(await rewriteImports(code, map)).toBe(allowed);
  });

  it('the CommonJS wrapper for Node processes keeps its imports with eval forbidden', async () => {
    await esmReady;
    const allowed = esmToCjs("import a from 'pkg';\nexport { b } from \"./b.js\";\nconsole.log(a);");
    forbidEval();
    const forbidden = esmToCjs("import a from 'pkg';\nexport { b } from \"./b.js\";\nconsole.log(a);");
    expect(forbidden).toBe(allowed);
    expect(forbidden).toContain('__bfwc_import("pkg")');
    expect(forbidden).toContain('__bfwc_import("./b.js")');
  });
});
