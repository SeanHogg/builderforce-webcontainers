import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { typecheckProject, type TypecheckResult } from '../src/check/typecheck.js';
import { formatDiagnostic } from '../src/check/diagnostics.js';
import { TypeStore, libBaseUrlFor } from '../src/check/typeStore.js';
import type { FetchLike, FetchResponseLike } from '../src/check/acquire.js';
import { ambientShim } from '../src/check/shims.js';

/**
 * The real TypeScript compiler over in-memory projects. The network is faked:
 * lib files come from the installed `typescript` package (exactly what jsDelivr
 * serves for that version), and a tiny esm.sh stand-in serves package types
 * with the `X-TypeScript-Types` header and redirects the real one uses.
 */
// `typescript` resolves to lib/typescript.js, beside the lib.*.d.ts files.
const LIB_DIR = dirname(createRequire(import.meta.url).resolve('typescript'));
const LIB_BASE = libBaseUrlFor(ts.version);

const REACT_INDEX = `export as namespace React;
declare global { namespace JSX { interface Element {} interface IntrinsicElements { [name: string]: any } } }
export declare function useState<T>(value: T): [T, (next: T) => void];
`;

interface FakeFile {
  body: string;
  /** The URL after redirects. */
  url?: string;
  types?: string;
}

const FAKE: Record<string, FakeFile> = {
  'https://esm.sh/react@^18.3.1': { body: 'export * from "/react.mjs"', types: 'https://esm.sh/@types/react@~18.3.1/index.d.ts' },
  'https://esm.sh/react@^18.3.1/jsx-runtime': { body: '', types: 'https://esm.sh/@types/react@~18.3.1/jsx-runtime.d.ts' },
  'https://esm.sh/@types/react@~18.3.1/index.d.ts': { body: REACT_INDEX, url: 'https://esm.sh/@types/react@18.3.9/index.d.ts' },
  'https://esm.sh/@types/react@~18.3.1/jsx-runtime.d.ts': {
    body: `import './index.d.ts';\nexport declare function jsx(type: any, props: any): JSX.Element;\nexport declare function jsxs(type: any, props: any): JSX.Element;\n`,
    url: 'https://esm.sh/@types/react@18.3.9/jsx-runtime.d.ts',
  },
  // A relative header (esm.sh sends absolute ones today; both must work).
  'https://esm.sh/tiny@^1.0.0': { body: '', types: '/tiny@1.0.0/index.d.ts' },
  'https://esm.sh/tiny@1.0.0/index.d.ts': { body: `import type { Options } from './options';\nexport declare function greet(name: string, options?: Options): string;\n` },
  'https://esm.sh/tiny@1.0.0/options.d.ts': { body: 'export interface Options { loud: boolean }\n' },
  'https://esm.sh/left-pad': { body: 'export default function(){}' }, // no types at all
  'https://cdn.jsdelivr.net/npm/@vue/tsconfig@^0.5.0/tsconfig.dom.json': { body: '{ "extends": "./tsconfig.json", "compilerOptions": { "lib": ["ES2020", "DOM"] } }' },
  'https://cdn.jsdelivr.net/npm/@vue/tsconfig@^0.5.0/tsconfig.json': { body: '{ "compilerOptions": { "strict": true, "noUnusedLocals": true, "jsx": "preserve" } }' },
};

function fakeFetch(log: string[] = []): FetchLike {
  return async (url) => {
    log.push(url);
    const response = (ok: boolean, body: string, finalUrl = url, types?: string): FetchResponseLike => ({
      ok,
      url: finalUrl,
      headers: { get: (name) => (name.toLowerCase() === 'x-typescript-types' ? types ?? null : null) },
      text: async () => body,
    });
    if (url.startsWith(`${LIB_BASE}/`)) {
      try {
        return response(true, readFileSync(join(LIB_DIR, url.slice(LIB_BASE.length + 1)), 'utf8'));
      } catch {
        return response(false, '');
      }
    }
    // Like esm.sh, an exact-version URL serves the file a range URL redirects to.
    const hit = FAKE[url] ?? Object.values(FAKE).find((file) => file.url === url);
    return hit ? response(true, hit.body, hit.url ?? url, hit.types) : response(false, 'not found');
  };
}

// One store for the suite, like a long-lived worker: lib files are parsed once.
const store = new TypeStore();
const check = (files: Record<string, string>, log?: string[]): Promise<TypecheckResult> =>
  typecheckProject(ts, files, { fetch: fakeFetch(log), store });

const REACT_PKG = JSON.stringify({ dependencies: { react: '^18.3.1', tiny: '^1.0.0', 'left-pad': '' } });

describe('typecheckProject', () => {
  it('passes a clean React + TS project with no tsconfig (synthesised strict defaults, react-jsx)', async () => {
    const result = await check({
      'package.json': REACT_PKG,
      'src/main.tsx': `import { useState } from 'react';\nexport function App() { const [n] = useState(1); return <h1>{n.toFixed(0)}</h1>; }`,
      'vite.config.ts': `this is not checked`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toEqual(['src/main.tsx']);
  }, 30_000);

  it('reports type errors with project-relative file, 1-based position, code and category', async () => {
    const result = await check({ 'src/a.ts': `export const ok = 1;\nconst n: string = 42;\nexport { n };` });
    expect(result.diagnostics).toEqual([
      { file: 'src/a.ts', line: 2, column: 7, code: 2322, category: 'error', message: "Type 'number' is not assignable to type 'string'." },
    ]);
    expect(formatDiagnostic(result.diagnostics[0]!)).toBe("src/a.ts(2,7): error TS2322: Type 'number' is not assignable to type 'string'.");
  });

  it('applies strict defaults when there is no tsconfig', async () => {
    const result = await check({ 'src/a.ts': `export function f(x) { return x; }` });
    expect(result.diagnostics.map((d) => d.code)).toEqual([7006]);
  });

  it('follows a solution tsconfig to its references and their options', async () => {
    const result = await check({
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }] }',
      'tsconfig.app.json': '{ "compilerOptions": { "strict": false, "noEmit": true, "composite": true, "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }',
      'tsconfig.node.json': '{ "compilerOptions": { "types": ["node"] }, "include": ["vite.config.ts"] }',
      'vite.config.ts': 'import { defineConfig } from "vite"; export default defineConfig({});',
      'src/a.ts': `import { b } from '@/b';\nexport function f(x) { return x + b; }`,
      'src/b.ts': `export const b = 1;`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('types imports Vite and CRA apps make without a local install', async () => {
    const result = await check({
      'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' } }),
      'src/vite-env.d.ts': '/// <reference types="vite/client" />',
      'src/a.ts': [
        `import logo from './logo.svg';`,
        `import styles from './a.module.css';`,
        `import './global.css';`,
        `import notes from './notes.md?raw';`,
        `import App from './App.vue';`,
        `import Widget from './Widget.svelte';`,
        `const title: string = import.meta.env.VITE_TITLE;`,
        `const cra: string | undefined = process.env.REACT_APP_X;`,
        `export const all = [logo.length, styles.btn, notes.length, App, Widget, title, cra];`,
      ].join('\n'),
    });
    expect(result.diagnostics).toEqual([]);
  });

  it('fetches package types through the CDN header, following relative imports and redirects', async () => {
    const result = await check({
      'package.json': REACT_PKG,
      'src/a.ts': `import { greet } from 'tiny';\nexport const s = greet('x', { loud: 'yes' });`,
    });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ file: 'src/a.ts', line: 2, code: 2322 });
    expect(store.files.has('https://esm.sh/tiny@1.0.0/options.d.ts')).toBe(true);
    expect(store.files.has('https://esm.sh/@types/react@18.3.9/index.d.ts')).toBe(true); // keyed by final URL
  });

  it('treats packages with no types as any, and says which', async () => {
    const result = await check({ 'package.json': REACT_PKG, 'src/a.ts': `import pad from 'left-pad';\nimport sub from 'left-pad/sub';\nexport const x: number = pad(sub);` });
    expect(result.diagnostics).toEqual([]);
    expect(result.untypedPackages).toEqual(['left-pad']);
  });

  it('resolves tsconfig `extends` from a package', async () => {
    const result = await check({
      'package.json': JSON.stringify({ devDependencies: { '@vue/tsconfig': '^0.5.0' } }),
      'tsconfig.json': '{ "extends": "@vue/tsconfig/tsconfig.dom.json", "include": ["src/**/*.ts"] }',
      'src/a.ts': `export function f() { const unused = 1; }`,
    });
    expect(result.diagnostics.map((d) => d.code)).toEqual([6133]);
  });

  it('reports syntax errors and config errors', async () => {
    const syntax = await check({ 'src/a.ts': `export const = ;` });
    expect(syntax.diagnostics[0]).toMatchObject({ file: 'src/a.ts', category: 'error' });
    const config = await check({ 'tsconfig.json': '{ "compilerOptions": { "target": "es1999" } }', 'src/a.ts': 'export {};' });
    expect(config.diagnostics.some((d) => d.file === 'tsconfig.json' || d.file === undefined)).toBe(true);
  });

  it('reuses a store: a second check of the same project makes no requests', async () => {
    const own = new TypeStore();
    const files = { 'package.json': REACT_PKG, 'src/a.tsx': `import { greet } from 'tiny';\nexport const e = <p>{greet('a')}</p>;` };
    const first: string[] = [];
    await typecheckProject(ts, files, { fetch: fakeFetch(first), store: own });
    const second: string[] = [];
    const result = await typecheckProject(ts, files, { fetch: fakeFetch(second), store: own });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  }, 30_000);

  it('returns nothing to check for a plain JS project', async () => {
    const result = await check({ 'index.html': '', 'main.js': 'console.log(1)' });
    expect(result).toEqual({ diagnostics: [], untypedPackages: [], files: [] });
  });
});

describe('ambientShim', () => {
  it('skips module patterns something else already declares', () => {
    const shim = ambientShim({ existing: [`declare module '*.vue' { const c: any; export default c; }`], untyped: ['x'] });
    expect(shim).not.toContain('declare module "*.vue"');
    expect(shim).toContain('declare module "*.svelte"');
    expect(shim).toContain('declare module "x";');
    expect(shim).toContain('declare var process');
    expect(ambientShim({ existing: ['declare var process: NodeJS.Process;'], untyped: [] })).not.toContain('declare var process');
  });
});
