import { describe, expect, it } from 'vitest';
import { parse } from '../../src/shell/parse.js';
import { exec, kernelWith, readAll } from '../node/helpers.js';
import { fakeRegistry, REGISTRY } from '../installer/fakeRegistry.js';
import type { Kernel } from '../../src/system/kernel.js';

const sh = (kernel: Kernel, script: string, options: { cwd?: string; input?: string } = {}) => exec(kernel, 'jsh', ['-c', script], options);

describe('shell parser', () => {
  it('splits lists, pipelines, redirects and assignments, keeping quoting', () => {
    const script = parse(`A=1 echo "x $A" 'y $A' | grep x > out.txt 2>&1 && ls || pwd; sleep 1 &`);
    expect(script).toHaveLength(2);
    const [first, second] = script;
    expect(first!.first.commands).toHaveLength(2);
    expect(first!.first.commands[0]!.assignments[0]!.name).toBe('A');
    expect(first!.first.commands[1]!.redirects.map((r) => r.op)).toEqual(['>', '2>&1']);
    expect(first!.rest.map((r) => r.op)).toEqual(['&&', '||']);
    expect(second!.background).toBe(true);
    expect(() => parse('echo "open')).toThrow(/unterminated/);
    expect(() => parse('a |')).toThrow();
  });
});

describe('shell execution', () => {
  it('expands variables and quotes, honours && || ; and $?', async () => {
    const kernel = kernelWith();
    const { output } = await sh(kernel, `X="a  b"; echo $X "$X" '$X' \${MISSING:-dflt}; false || echo fallback; true && echo yes; echo $?`);
    expect(output).toBe('a b a  b $X dflt\nfallback\nyes\n0\n');
  });

  it('pipes, redirects and command substitution', async () => {
    const kernel = kernelWith();
    const { output } = await sh(kernel, `printf 'b\\na\\nc\\n' | grep -v c | head -n 1; echo hi > out.txt; echo there >> out.txt; cat out.txt; cat < out.txt | wc -l; echo "[$(echo inner)]"; nosuch 2> err.txt; cat err.txt`);
    expect(output).toBe('b\nhi\nthere\n      2\n[inner]\njsh: command not found: nosuch\n');
    expect(kernel.fs.readText('/out.txt')).toBe('hi\nthere\n');
  });

  it('file commands, globs, cd/pwd/export', async () => {
    const kernel = kernelWith({ 'a.js': '', 'b.js': '', 'c.txt': '' });
    const { output, code } = await sh(kernel, `mkdir -p d/e && touch d/e/x.js && ls d/e && cp -r d z && mv z/e z/f && ls z && rm -rf d && ls && echo *.js && cd z/f && pwd && export Y=2 && echo $Y && cd - && ls nope`);
    expect(output).toBe('x.js\nf\na.js\nb.js\nc.txt\nz\na.js b.js\n/z/f\n2\n/\nls: cannot access \'nope\': No such file or directory\n');
    expect(code).toBe(2);
  });

  it('reports unknown commands with 127', async () => {
    expect(await sh(kernelWith(), 'definitely-missing')).toEqual({ output: 'jsh: command not found: definitely-missing\n', code: 127 });
  });

  it('runs node, with per-command env assignments and stdin', async () => {
    const kernel = kernelWith({ 'echo.js': 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))' });
    const { output } = await sh(kernel, `FOO=bar node -e 'console.log(process.env.FOO)'; echo piped | node echo.js`);
    expect(output).toBe('bar\nPIPED\n');
  });

  it('npm run: pre/post scripts, args after --, node_modules/.bin on PATH', async () => {
    const kernel = kernelWith({
      'package.json': JSON.stringify({ name: 'app', version: '1.0.0', scripts: { prebuild: 'echo pre', build: 'tool --flag', postbuild: 'echo post', fail: 'exit 3' } }),
      'node_modules/.bin/tool': '#!/usr/bin/env node\n// @bfwc-bin ../tool/cli.js\nrequire("../tool/cli.js");\n',
      'node_modules/tool/cli.js': 'console.log("tool", process.argv.slice(2).join(" "), process.env.npm_lifecycle_event, require.main === module)',
    });
    const { output } = await sh(kernel, 'npm run build -- extra && npm run fail; echo status $?');
    expect(output).toContain('> app@1.0.0 build\n> tool --flag extra\n\ntool --flag extra build true\n');
    expect(output.indexOf('pre\n')).toBeLessThan(output.indexOf('tool --flag extra build'));
    expect(output).toContain('post\n');
    expect(output).toContain('npm error code 3');
    expect(output.trim().endsWith('status 3')).toBe(true);
  });

  it('npm install from a registry, saves the spec, then npx runs the bin', async () => {
    const registry = await fakeRegistry({
      greet: { versions: { '1.2.0': { bin: { greet: 'bin.js' }, files: { 'bin.js': '#!/usr/bin/env node\nconsole.log("hello from greet")' } } } },
    });
    const kernel = kernelWith({ 'package.json': '{"name":"app"}' }, { fetch: registry.fetch as never, registry: REGISTRY });
    const { output, code } = await sh(kernel, 'npm install greet && npx greet && npm ls');
    expect(code).toBe(0);
    expect(output).toContain('added 1 package');
    expect(output).toContain('hello from greet\n');
    expect(output).toContain('└── greet@1.2.0');
    expect(JSON.parse(kernel.fs.readText('/package.json')!).dependencies).toEqual({ greet: '^1.2.0' });
  });

  it('hands `npm run dev` (vite) off to the in-browser dev server', async () => {
    const kernel = kernelWith({ 'package.json': JSON.stringify({ scripts: { dev: 'vite --port 5174' } }) }, { previewUrl: 'https://app.test/__bfwc/p1/' });
    const ready = new Promise<[number, string]>((resolve) => kernel.on('server-ready', (port, url) => resolve([port, url])));
    const proc = kernel.spawn('npm', ['run', 'dev']);
    const output = readAll(proc.output);
    expect(await ready).toEqual([5174, 'https://app.test/__bfwc/p1/']);
    proc.kill('SIGINT');
    await proc.exit;
    expect(await output).toContain('https://app.test/__bfwc/p1/');
  });
});

describe('interactive shell', () => {
  it('edits lines, recalls history, runs commands and exits', async () => {
    const kernel = kernelWith({ 'sub/file.txt': 'x' });
    const proc = kernel.spawn('jsh', [], { terminal: { cols: 80, rows: 24 } });
    const output = readAll(proc.output);
    const writer = proc.input.getWriter();
    const tick = () => new Promise((r) => setTimeout(r, 20));
    await writer.write('echo hellp\x7fo\r');
    await tick();
    await writer.write('cd sub\r');
    await tick();
    await writer.write('\x1b[A\x1b[A\r'); // history: echo hello
    await tick();
    await writer.write('ls\r');
    await tick();
    await writer.write('echo partial\x03');
    await tick();
    await writer.write('exit 4\r');
    expect(await proc.exit).toBe(4);
    const text = await output;
    // Each run: the echoed command line, then its output line.
    expect(text.split('hello\r\nhello\r\n').length - 1).toBe(2);
    expect(text).toContain('file.txt\r\n');
    expect(text).toContain('/sub');
    expect(text).toContain('^C');
  });
});
