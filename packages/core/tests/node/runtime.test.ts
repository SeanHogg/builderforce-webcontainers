import { describe, expect, it } from 'vitest';
import { exec, kernelWith, runNode } from './helpers.js';

describe('node runtime: modules', () => {
  it('runs a script, prints, and exits with process.exitCode / process.exit', async () => {
    expect(await runNode({ 'index.js': 'console.log("hi", 1 + 1, { a: [1, 2] }); process.exitCode = 2;' })).toMatchObject({ output: 'hi 2 { a: [ 1, 2 ] }\n', code: 2 });
    expect(await runNode({ 'index.js': 'process.stdout.write("a"); process.exit(3); console.log("never")' })).toMatchObject({ output: 'a', code: 3 });
  });

  it('resolves relative files, JSON, directories, node_modules main and exports conditions', async () => {
    const { output, code } = await runNode({
      'index.js': `
        const util = require('./lib/util');
        const data = require('./data.json');
        const dep = require('dep');
        const sub = require('dual/feature');
        console.log(util.name, data.n, dep, sub, __filename, __dirname.length > 0);
        console.log(require('./lib/util') === util, require.resolve('dep'), typeof require.cache[require.resolve('./lib/util')]);
      `,
      'lib/util/index.js': 'exports.name = "util";',
      'data.json': '{"n": 42}',
      'node_modules/dep/package.json': '{"main": "main.js"}',
      'node_modules/dep/main.js': 'module.exports = "dep-main";',
      'node_modules/dual/package.json': JSON.stringify({ exports: { './feature': { import: './esm.mjs', require: './cjs.js' }, './package.json': './package.json' } }),
      'node_modules/dual/cjs.js': 'module.exports = "cjs-build";',
      'node_modules/dual/esm.mjs': 'export default "esm-build";',
    });
    expect(output).toBe('util 42 dep-main cjs-build /index.js true\ntrue /node_modules/dep/main.js object\n');
    expect(code).toBe(0);
  });

  it('reports a missing module with MODULE_NOT_FOUND and exits 1', async () => {
    const { output, code } = await runNode({ 'index.js': 'try { require("nope") } catch (e) { console.log(e.code) } require("./missing")' });
    expect(output).toContain('MODULE_NOT_FOUND\n');
    expect(output).toContain("Cannot find module './missing'");
    expect(code).toBe(1);
  });

  it('runs ES modules: named, default and namespace imports, CJS interop, live exports, dynamic import, import.meta', async () => {
    const { output, code } = await runNode(
      {
        'main.mjs': `
          import def, { a, b as bee, counter, bump } from './lib.mjs';
          import * as ns from './lib.mjs';
          import cjs, { named } from './legacy.cjs';
          import path from 'node:path';
          export const x = 1, y = 2;
          console.log(def, a, bee, ns.a, cjs.named, named, path.basename('/a/b.txt'));
          bump();
          console.log(counter, ns.counter);
          const dyn = await import('./lib.mjs');
          console.log(dyn.a, import.meta.url, typeof import.meta.dirname);
        `,
        'lib.mjs': `
          export const a = 'A', b = 'B';
          export let counter = 0;
          export function bump() { counter++; }
          export default function named() { return 'D'; }
        `,
        'legacy.cjs': 'module.exports = { named: "N" };',
      },
      'main.mjs',
    );
    expect(output).toBe("[Function: named] A B A N N b.txt\n0 1\nA file:///main.mjs string\n");
    expect(code).toBe(0);
  });

  it('treats .js under "type": "module" (and ESM-syntax .js) as ES modules', async () => {
    const { output } = await runNode({
      'package.json': '{"type": "module"}',
      'index.js': "import { v } from './v.js'; export default 1; console.log(v)",
      'v.js': 'export const v = "typed";',
    });
    expect(output).toBe('typed\n');
    const detected = await runNode({ 'index.js': "import { v } from './v.js'; console.log(v)", 'v.js': 'export const v = "detected";' });
    expect(detected.output).toBe('detected\n');
  });

  it('prefers a dual package\'s CommonJS build from ESM, falling back to "import" for ESM-only packages', async () => {
    const { output } = await runNode(
      {
        'main.mjs': "import dual from 'dual'; import only from 'only'; console.log(dual, only)",
        'node_modules/dual/package.json': JSON.stringify({ exports: { import: './esm.mjs', require: './cjs.js' } }),
        'node_modules/dual/cjs.js': 'module.exports = "cjs";',
        'node_modules/dual/esm.mjs': 'export default "esm";',
        'node_modules/only/package.json': JSON.stringify({ type: 'module', exports: { '.': { import: './index.js' } } }),
        'node_modules/only/index.js': 'export default "esm-only";',
      },
      'main.mjs',
    );
    expect(output).toBe('cjs esm-only\n');
  });

  it('handles uncaught errors: stack to stderr, exit 1; uncaughtException listeners recover', async () => {
    const crash = await runNode({ 'index.js': 'setTimeout(() => { throw new Error("boom") }, 1)' });
    expect(crash.code).toBe(1);
    expect(crash.output).toContain('Error: boom');
    const handled = await runNode({ 'index.js': 'process.on("uncaughtException", (e) => console.log("caught", e.message)); setTimeout(() => { throw new Error("x") }, 1)' });
    expect(handled).toMatchObject({ output: 'caught x\n', code: 0 });
  });
});

describe('node runtime: event loop', () => {
  it('stays alive for timers and intervals, then exits when idle', async () => {
    const { output, code } = await runNode({
      'index.js': `
        let n = 0;
        const t = setInterval(() => { n++; if (n === 3) { clearInterval(t); console.log('interval', n); } }, 1);
        setTimeout(() => console.log('timeout'), 40);
        setImmediate(() => console.log('immediate'));
        process.nextTick(() => console.log('tick'));
        Promise.resolve().then(() => console.log('micro'));
        const u = setTimeout(() => console.log('never'), 100000); u.unref();
        process.on('exit', (c) => console.log('exit', c));
      `,
    });
    expect(output.split('\n').filter(Boolean)).toEqual(['tick', 'micro', 'immediate', 'interval 3', 'timeout', 'exit 0']);
    expect(code).toBe(0);
  });

  it('reads stdin to the end', async () => {
    const { output } = await runNode({ 'index.js': 'let s = ""; process.stdin.on("data", (d) => s += d); process.stdin.on("end", () => console.log(s.toUpperCase()))' }, 'index.js', [], { input: 'hello\nworld' });
    expect(output).toBe('HELLO\nWORLD\n');
  });

  it('supports node -e, -p and argv', async () => {
    const kernel = kernelWith();
    expect((await exec(kernel, 'node', ['-p', '6 * 7'])).output).toBe('42\n');
    expect((await exec(kernel, 'node', ['-e', 'console.log(process.argv.slice(1).join(","))', 'a', 'b'])).output).toBe('a,b\n');
    expect((await exec(kernel, 'node', ['-v'])).output).toMatch(/^v20\./);
  });
});
