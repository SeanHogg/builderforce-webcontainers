import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { DevServer } from '../../src/devServer.js';
import { createEsbuildTransformer } from '../../src/transformer.js';
import { parse, type SimpleCommand } from '../../src/shell/parse.js';
import { exec, kernelWith, readAll } from '../node/helpers.js';
import { fakeRegistry, REGISTRY } from '../installer/fakeRegistry.js';
import type { Kernel } from '../../src/system/kernel.js';
import { matchDevServer, runDevServerHandoff } from '../../src/shell/devHandoff.js';

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

  /** Start `command args` in `cwd`; resolves with what it announced, then stops it. */
  async function announced(kernel: Kernel, command: string, args: string[], cwd?: string) {
    const ready = new Promise<{ port: number; url: string; root?: string }>((resolve) => kernel.servers.onListening(resolve));
    const proc = kernel.run(command, args, { cwd });
    const server = await ready;
    proc.kill('SIGINT');
    await proc.wait();
    return server;
  }

  it('announces the working directory as the root, so a frontend in /web is served from /web', async () => {
    const kernel = kernelWith(
      {
        'web/package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5.4.0' } }),
        'web/index.html': '<!doctype html><script type="module" src="/src/main.ts"></script>',
        'api/package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
      },
      { previewUrl: 'https://app.test/__bfwc/p1/' },
    );
    expect(await announced(kernel, 'npm', ['run', 'dev'], '/web')).toEqual({ port: 5173, url: 'https://app.test/__bfwc/p1/', root: '/web' });
    expect(await announced(kernel, 'bfsh', ['-c', 'cd web && npx vite --port 5180'])).toEqual({ port: 5180, url: 'https://app.test/__bfwc/p1/', root: '/web' });
  });

  it('hands Angular `ng serve` off (directly, through npx and through `npm start`), honouring --port', async () => {
    const files = {
      'package.json': JSON.stringify({ scripts: { start: 'ng serve --port 4300' }, dependencies: { '@angular/core': '^19.0.0' } }),
      'angular.json': '{}',
    };
    const kernel = kernelWith(files, { previewUrl: 'https://app.test/__bfwc/p1/' });
    expect(await announced(kernel, 'npm', ['start'])).toMatchObject({ port: 4300, root: '/' });
    expect(await announced(kernel, 'npx', ['ng', 'serve'])).toMatchObject({ port: 4200 });
    expect(await announced(kernel, 'bfsh', ['-c', 'ng s --port=4321'])).toMatchObject({ port: 4321 });
    expect(matchDevServer(['ng', 'build'])).toBeUndefined();
  });

  it('boots a service whose command is a bare `vite` with no package.json, and the preview serves the launched page at /', async () => {
    const kernel = kernelWith({ 'mock.html': '<html><body>mock page</body></html>', 'mock.css': 'body{color:red}' }, { previewUrl: 'https://app.test/__bfwc/p1/' });
    // Spawned directly, as a manifest service's plain command is (no shell): `vite` is a program, not "command not found".
    expect(await announced(kernel, 'vite', [])).toEqual({ port: 5173, url: 'https://app.test/__bfwc/p1/', root: '/' });
    const server = new DevServer({ fs: kernel.fs, transformer: createEsbuildTransformer(esbuild), base: '/__bfwc/p1/', page: '/mock.html' });
    const body = (await server.handle('/')).body;
    expect(typeof body === 'string' ? body : new TextDecoder().decode(body)).toContain('mock page');
  });

  it('without a preview a directly spawned `vite` runs the installed binary, as a shell line does', async () => {
    const kernel = kernelWith({ 'node_modules/.bin/vite': '#!/usr/bin/env node\nconsole.log("installed vite " + process.argv.slice(2).join(" "))' });
    expect(await exec(kernel, 'vite', ['--help'])).toEqual({ output: 'installed vite --help\n', code: 0 });
    expect(await sh(kernel, 'vite --help')).toEqual({ output: 'installed vite --help\n', code: 0 });
  });

  it('an installed `vite` run on a terminal gets the terminal size and raw keystrokes, as any external command does', async () => {
    const script = [
      '#!/usr/bin/env node',
      "console.log('tty=' + process.stdout.isTTY + ' cols=' + process.stdout.columns);",
      'process.stdin.setRawMode(true);',
      "process.stdin.once('data', (d) => { console.log('raw=' + JSON.stringify(String(d))); process.exit(0); });",
      "console.log('ready');",
    ].join('\n');
    const kernel = kernelWith({ 'node_modules/.bin/vite': script });
    const proc = kernel.run('vite', [], { terminal: { cols: 100, rows: 30 } });
    const reader = proc.combinedOutput.getReader();
    let text = '';
    const until = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) return;
        text += value;
      }
    };
    // The key is written only once the child is in raw mode (it says so): before that the terminal is cooked and holds a line without a newline.
    await until('ready');
    await proc.stdin.getWriter().write('q'); // no newline: only a raw tap delivers it
    expect(await proc.wait()).toBe(0);
    await until('raw=');
    expect(text).toContain('tty=true cols=100');
    expect(text).toContain('raw="q"');
  });

  it('a direct spawn of an installed `vite` keeps its ipc channel (no wrapper in between)', async () => {
    const script = ['#!/usr/bin/env node', "process.send({ from: 'vite' });", 'process.exit(0);'].join('\n');
    const kernel = kernelWith({ 'node_modules/.bin/vite': script });
    const child = kernel.spawnChild('vite', [], { ipc: true });
    const message = new Promise((resolve) => child.ipc!.onMessage(resolve));
    expect(await message).toEqual({ from: 'vite' });
    expect(await child.exit).toBe(0);
  });

  it('an absolute-path spawn of a dev-server tool follows the same gate: handed off with a preview, command not found without one', async () => {
    const withPreview = kernelWith({}, { previewUrl: 'https://app.test/__bfwc/p1/' });
    expect(await announced(withPreview, '/usr/local/bin/vite', [])).toMatchObject({ port: 5173 });
    const without = kernelWith({});
    expect(() => without.run('/usr/local/bin/vite')).toThrow(/ENOENT/);
  });

  it('with nothing installed and no handoff, `vite` is command not found: ENOENT directly, the shell line\'s message in a shell', async () => {
    const kernel = kernelWith({});
    expect(() => kernel.run('vite')).toThrow(/ENOENT/);
    expect(await sh(kernel, 'vite')).toEqual({ output: 'bfsh: command not found: vite\n', code: 127 });
  });

  it('withdraws the handoff when it is interrupted, so the host stops serving its directory', async () => {
    const withdrawn: number[] = [];
    const abort = new AbortController();
    const ctx = {
      cwd: '/web',
      env: {},
      signal: abort.signal,
      io: { stdout: () => undefined, stderr: () => undefined },
      system: { previewUrl: 'https://app.test/__bfwc/p1/', announceServer: (port: number) => () => void withdrawn.push(port) },
    };
    const running = runDevServerHandoff(ctx as never, ['vite'], matchDevServer(['vite'])!);
    await Promise.resolve();
    expect(withdrawn).toEqual([]);
    abort.abort();
    expect(await running).toBe(130);
    expect(withdrawn).toEqual([5173]);
    expect(matchDevServer(['ng', 'serve'])).toEqual({ tool: 'angular', defaultPort: 4200 });
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
