import { describe, expect, it } from 'vitest';
import { parse, type SimpleCommand } from '../../src/shell/parse.js';
import { exec, kernelWith, readAll } from '../node/helpers.js';
import { fakeRegistry, REGISTRY } from '../installer/fakeRegistry.js';
import type { Kernel } from '../../src/system/kernel.js';

const sh = (kernel: Kernel, script: string, options: { cwd?: string; input?: string } = {}) => exec(kernel, 'bfsh', ['-c', script], options);

describe('shell parser', () => {
  it('splits lists, pipelines, redirects and assignments, keeping quoting', () => {
    const script = parse(`A=1 echo "x $A" 'y $A' | grep x > out.txt 2>&1 && ls || pwd; sleep 1 &`);
    expect(script).toHaveLength(2);
    const [first, second] = script;
    expect(first!.first.commands).toHaveLength(2);
    const [echo, grep] = first!.first.commands as SimpleCommand[];
    expect(echo!.assignments[0]!.name).toBe('A');
    expect(grep!.redirects.map((r) => r.op)).toEqual(['>', '2>&1']);
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

  it('fails a pipeline when any stage exits non-zero (pipefail)', async () => {
    const kernel = kernelWith();
    // A later success must not hide an earlier failure; every stage 0 stays 0.
    expect(await sh(kernel, 'false | true')).toMatchObject({ code: 1 });
    expect(await sh(kernel, 'true | false | true')).toMatchObject({ code: 1 });
    expect(await sh(kernel, 'true | true')).toMatchObject({ code: 0 });
    expect(await sh(kernel, 'echo hi | cat')).toEqual({ output: 'hi\n', code: 0 });
    // Rightmost non-zero wins, and && must see the pipeline failure.
    expect((await sh(kernel, `node -e 'process.exit(3)' | true`)).code).toBe(3);
    expect((await sh(kernel, `node -e 'process.exit(3)' | node -e 'process.exit(4)'`)).code).toBe(4);
    expect(await sh(kernel, 'false | true && echo leaked; echo after')).toEqual({ output: 'after\n', code: 0 });
    // A command that is not a pipeline is unchanged.
    expect(await sh(kernel, 'false')).toMatchObject({ code: 1 });
    expect(await sh(kernel, 'true')).toMatchObject({ code: 0 });
  });

  it('opts out to POSIX pipeline status with set +o pipefail, or bfsh +o pipefail', async () => {
    const kernel = kernelWith();
    // POSIX: the last stage's status.
    expect(await sh(kernel, 'set +o pipefail; false | true')).toMatchObject({ code: 0 });
    expect(await sh(kernel, 'set +o pipefail; true | false')).toMatchObject({ code: 1 });
    expect(await sh(kernel, 'set +o pipefail; false | true && echo ran')).toEqual({ output: 'ran\n', code: 0 });
    // And back on, mid-script; subshells inherit the setting.
    expect(await sh(kernel, 'set +o pipefail; set -o pipefail; false | true')).toMatchObject({ code: 1 });
    expect(await sh(kernel, 'set +o pipefail; (false | true)')).toMatchObject({ code: 0 });
    // At invocation.
    expect(await exec(kernel, 'bfsh', ['+o', 'pipefail', '-c', 'false | true'])).toMatchObject({ code: 0 });
    expect(await exec(kernel, 'bfsh', ['-o', 'pipefail', '-c', 'false | true'])).toMatchObject({ code: 1 });
    // Listing, positional parameters, and refusing what is not supported.
    expect((await sh(kernel, 'set -o')).output).toBe('pipefail       on\n');
    expect((await sh(kernel, 'set +o pipefail; set +o')).output).toBe('set +o pipefail\n');
    expect((await sh(kernel, 'set -- a b; echo $2 $#')).output).toBe('b 2\n');
    expect(await sh(kernel, 'set -o nosuch')).toMatchObject({ code: 2 });
    // Real options this shell does not model are accepted and ignored, so ordinary
    // `set -euo pipefail` script headers keep working; pipefail inside the cluster is real.
    expect(await sh(kernel, 'set -e; echo ok')).toMatchObject({ code: 0, output: 'ok\n' });
    expect(await sh(kernel, 'set -o errexit -x; echo ok')).toMatchObject({ code: 0, output: 'ok\n' });
    expect(await sh(kernel, 'set +o pipefail; set -euo pipefail; false | true')).toMatchObject({ code: 1 });
    expect(await exec(kernel, 'bfsh', ['+o', 'nosuch', '-c', 'true'])).toMatchObject({ code: 2 });
  });

  it('stops a writer whose reader exited with SIGPIPE (141) instead of buffering forever', async () => {
    const kernel = kernelWith();
    // An in-process writer (a builtin in an endless loop) and a spawned one (node).
    expect(await sh(kernel, 'while true; do echo y; done | head -n 1')).toEqual({ output: 'y\n', code: 141 });
    expect(await sh(kernel, `node -e "setInterval(() => console.log('y'), 1)" | head -n 2`)).toEqual({ output: 'y\ny\n', code: 141 });
    // POSIX status: the last stage's, so the pipeline succeeds.
    expect(await sh(kernel, 'set +o pipefail; while true; do echo y; done | head -n 1')).toEqual({ output: 'y\n', code: 0 });
    // A writer that finished before its reader exited is unaffected.
    expect(await sh(kernel, `printf 'a\\nb\\n' | head -n 1`)).toEqual({ output: 'a\n', code: 0 });
  });

  it('ends a loop, group or nested pipeline whose writes hit a closed pipe, after the earlier scenarios on one kernel', async () => {
    // The scenarios above, then SIGPIPE, in file order on one kernel: a broken pipe raised
    // inside a loop must end the stage, not be absorbed by the loop body's own pipeline.
    const kernel = kernelWith();
    expect(await sh(kernel, `X="a  b"; echo $X; false || echo fallback; echo $?`)).toEqual({ output: 'a b\nfallback\n0\n', code: 0 });
    expect(await sh(kernel, 'false | true')).toMatchObject({ code: 1 });
    expect((await sh(kernel, `node -e 'process.exit(3)' | node -e 'process.exit(4)'`)).code).toBe(4);
    expect(await sh(kernel, 'set +o pipefail; false | true')).toMatchObject({ code: 0 });
    expect(await sh(kernel, 'while true; do echo y; done | head -n 1')).toEqual({ output: 'y\n', code: 141 });
    expect(await sh(kernel, `node -e "setInterval(() => console.log('y'), 1)" | head -n 2`)).toEqual({ output: 'y\ny\n', code: 141 });
    // Nested: the inner pipeline's last stage writes into the outer pipe; a group; a for loop.
    expect(await sh(kernel, 'while true; do echo y | cat; done | head -n 1')).toEqual({ output: 'y\n', code: 141 });
    expect(await sh(kernel, '{ while true; do echo y; done; echo never; } | head -n 1')).toEqual({ output: 'y\n', code: 141 });
    expect(await sh(kernel, 'for i in 1 2 3; do while true; do echo $i; done; done | head -n 1; echo after $?')).toEqual({ output: '1\nafter 141\n', code: 0 });
    // A spawned writer inside a loop: SIGPIPE kills it and ends the loop around it.
    expect(await sh(kernel, `while true; do node -e "console.log('y')"; done | head -n 1`)).toEqual({ output: 'y\n', code: 141 });
    // The kernel is still usable afterwards: nothing left running holds it up.
    expect(await sh(kernel, 'echo still here')).toEqual({ output: 'still here\n', code: 0 });
  });

  it('pipes, redirects and command substitution', async () => {
    const kernel = kernelWith();
    const { output } = await sh(kernel, `printf 'b\\na\\nc\\n' | grep -v c | head -n 1; echo hi > out.txt; echo there >> out.txt; cat out.txt; cat < out.txt | wc -l; echo "[$(echo inner)]"; nosuch 2> err.txt; cat err.txt`);
    expect(output).toBe('b\nhi\nthere\n      2\n[inner]\nbfsh: command not found: nosuch\n');
    expect(kernel.fs.readText('/out.txt')).toBe('hi\nthere\n');
  });

  it('file commands, globs, cd/pwd/export', async () => {
    const kernel = kernelWith({ 'a.js': '', 'b.js': '', 'c.txt': '' });
    const { output, code } = await sh(kernel, `mkdir -p d/e && touch d/e/x.js && ls d/e && cp -r d z && mv z/e z/f && ls z && rm -rf d && ls && echo *.js && cd z/f && pwd && export Y=2 && echo $Y && cd - && ls nope`);
    expect(output).toBe('x.js\nf\na.js\nb.js\nc.txt\nz\na.js b.js\n/z/f\n2\n/\nls: cannot access \'nope\': No such file or directory\n');
    expect(code).toBe(2);
  });

  it('reports unknown commands with 127', async () => {
    expect(await sh(kernelWith(), 'definitely-missing')).toEqual({ output: 'bfsh: command not found: definitely-missing\n', code: 127 });
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
    const ready = new Promise<[number, string]>((resolve) => kernel.servers.onListening(({ port, url }) => resolve([port, url])));
    const proc = kernel.run('npm', ['run', 'dev']);
    const output = readAll(proc.combinedOutput);
    expect(await ready).toEqual([5174, 'https://app.test/__bfwc/p1/']);
    proc.kill('SIGINT');
    await proc.wait();
    expect(await output).toContain('https://app.test/__bfwc/p1/');
  });
});

describe('interactive shell', () => {
  it('edits lines, recalls history, runs commands and exits', async () => {
    const kernel = kernelWith({ 'sub/file.txt': 'x' });
    const proc = kernel.run('bfsh', [], { terminal: { cols: 80, rows: 24 } });
    const output = readAll(proc.combinedOutput);
    const writer = proc.stdin.getWriter();
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
    expect(await proc.wait()).toBe(4);
    const text = await output;
    // Each run: the echoed command line, then its output line.
    expect(text.split('hello\r\nhello\r\n').length - 1).toBe(2);
    expect(text).toContain('file.txt\r\n');
    expect(text).toContain('/sub');
    expect(text).toContain('^C');
  });
});
