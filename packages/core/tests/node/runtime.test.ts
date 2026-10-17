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

  it('ignores a straggling callback that writes or exits again after the process exited', async () => {
    const { output, code } = await runNode({ 'index.js': 'require("fs").promises.readFile("/index.js").then(() => { console.error("late"); process.exit(2); }); console.log("early"); process.exit(0);' });
    expect(code).toBe(0);
    expect(output).toBe('early\n');
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
        setTimeout(() => console.log('timeout'), 250); // well past 3 × 1ms ticks even at Windows' ~16ms timer granularity
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
    // The in-browser-runtime marker tools check to choose WebAssembly builds (Next.js's SWC).
    expect((await exec(kernel, 'node', ['-p', 'typeof process.versions.webcontainer'])).output).toBe('string\n');
  });
});

describe('spawning process.execPath', () => {
  it('runs the node program, as tools that re-launch node expect', async () => {
    const { output, code } = await runNode({
      'index.js': `require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'inherit' }).on('exit', (c) => console.log('child exited', c));`,
      'child.js': `console.log('in child', process.execPath);`,
    });
    expect(code).toBe(0);
    expect(output).toBe('in child /usr/local/bin/node\nchild exited 0\n');
  });
});

describe('modules declaring names the wrapper provides', () => {
  it('lets ES modules and CommonJS declare require, __filename, process and Buffer themselves', async () => {
    const { output, code } = await runNode(
      {
        'main.mjs': `
          import process from 'node:process';
          import { createRequire } from 'node:module';
          import { fileURLToPath } from 'node:url';
          const require = createRequire(import.meta.url);
          const __filename = fileURLToPath(import.meta.url);
          export const name = 'esm';
          console.log(__filename, typeof process.cwd, require('./legacy.cjs'));
        `,
        'legacy.cjs': `const Buffer = require('buffer').Buffer; const process = require('process'); module.exports = Buffer.from('ok').toString() + typeof process.cwd;`,
      },
      'main.mjs',
    );
    expect(code).toBe(0);
    expect(output).toBe('/main.mjs function okfunction\n');
  });
});

describe('binary stdio', () => {
  it("carries bytes through a child's stdin and stdout untouched (esbuild's service protocol)", async () => {
    const { output, code } = await runNode({
      'index.js': `
        const child = require('child_process').spawn(process.execPath, ['echo.js']);
        const got = [];
        child.stdout.on('data', (d) => got.push(d));
        child.on('close', () => { const all = Buffer.concat(got); console.log(Buffer.isBuffer(got[0]), [...all].join(',')); });
        child.stdin.end(Buffer.from([0, 255, 128, 10, 0xe2, 0x82]));
      `,
      'echo.js': `process.stdin.on('data', (d) => process.stdout.write(Buffer.concat([Buffer.from([7]), d])));`,
    });
    expect(code).toBe(0);
    expect(output).toBe('true 7,0,255,128,10,226,130\n');
  });
});

describe('children die with their parent', () => {
  it('kills a still-running child (and frees its port) when the parent exits, unless detached', async () => {
    const { kernel, output, code } = await runNode({
      'index.js': `
        const { spawn } = require('child_process');
        spawn(process.execPath, ['server.js', '4100'], { detached: true }).unref();
        spawn(process.execPath, ['server.js', '4000']).stdout.on('data', (d) => { console.log(String(d).trim()); process.exit(0); });
      `,
      'server.js': `const port = Number(process.argv[2]); require('http').createServer(() => {}).listen(port, () => console.log('up', port));`,
    });
    expect(code).toBe(0);
    expect(output).toBe('up 4000\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kernel.ports.has(4000)).toBe(false);
    expect(kernel.ports.has(4100)).toBe(true);
  });
});

describe('dynamic import() in CommonJS', () => {
  it("loads the project's module, not the host's", async () => {
    const { output, code } = await runNode({
      'index.js': `const name = './cli/run.js';\nimport(name).then((m) => m.start('ok'));\nimport('./esm.mjs').then((m) => console.log(m.default));\nimport(require('url').pathToFileURL('/esm.mjs').href).then((m) => console.log('by url', m.default));`,
      'cli/run.js': `exports.start = (word) => console.log('started', word);`,
      'esm.mjs': `export default 'from esm';`,
    });
    expect(code).toBe(0);
    expect(output).toContain('started ok');
    expect(output).toContain('from esm');
    expect(output).toContain('by url from esm');
  });
});
