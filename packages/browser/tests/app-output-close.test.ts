/**
 * The output-stream guarantee every runtime provider gives (ROADMAP item 25):
 * when a process exits, its output stream (`RuntimeProcess.combinedOutput`, a
 * service handle's `output`) delivers everything written before the exit —
 * the last line too, with or without its newline — and then ENDS. So a host
 * reading a setup step's output (`composer install`, `npm install`) never needs
 * a timeout after the exit; and `app.logs(id)` holds a one-off service's last
 * line before the service is marked ready (or stopped).
 *
 * Each provider on its real engine, in this thread (only the Worker boundary is
 * faked): Node (the process Worker's own runtime, a nested child included),
 * PHP (php-wasm: the CLI and Composer), Python (Pyodide), Rust (prebuilt WASI
 * module; skipped until built), .NET (the Mono bundle; skipped until built) and
 * the PGlite database (its log ends when it closes).
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeProvider, StateChange } from '@seanhogg/builderforce-webcontainers-core/app';
import { createNodeProvider, createPgliteProvider, startApplicationRuntime, type ApplicationRuntime, type ApplicationSpec, type NodeServiceHost } from '../src/app.js';
import type { ProcessHost } from '../src/node/processHost.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import { stubRuntime } from './app-fakeProvider.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { DOTNET_BUNDLE_DIR, dotnetHost, loadBundledDotnet } from './dotnet-helpers.js';
import { host, readAll } from './helpers.js';
import { phpHost, phpWorkers } from './php-helpers.js';
import { pythonHost } from './python-helpers.js';
import { RUST_FIXTURES_DIR, fixture, rustHost } from './rust-helpers.js';

const SLOW = 300_000;

function runtimeOf(processes: ProcessHost): NodeServiceHost {
  return {
    run: (command, args, options) => processes.run(command, args, options),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
  };
}

/** Read the stream to its end (it must end: the test times out otherwise) and take the exit, both without a post-exit wait. */
async function outputAndExit(proc: { combinedOutput: ReadableStream<string>; wait(): Promise<number> }): Promise<{ output: string; code: number }> {
  const [output, code] = await Promise.all([readAll(proc.combinedOutput), proc.wait()]);
  return { output, code };
}

/** No network: a fetch that fails, so a test that reaches for one fails loudly. */
const offline: typeof fetch = async (input) => {
  throw new Error(`Unexpected fetch of ${String(input)}`);
};

/**
 * A provider whose process writes `serving`, then exits — at once with `exit`'s code, or when signalled
 * (`on-signal`: writing `shut down (<signal>)`, unterminated, as it goes) — and ends its output `closeAfterMs`
 * after the exit (`never`: a provider that breaks the guarantee).
 */
function scriptedProvider(options: { exit: number | 'on-signal'; closeAfterMs: number | 'never' }): RuntimeProvider {
  return {
    id: 'scripted',
    accepts: () => ({ ok: true }),
    start() {
      let controller!: ReadableStreamDefaultController<string>;
      const output = new ReadableStream<string>({ start: (c) => void (controller = c) });
      controller.enqueue('serving\n');
      let settle!: (code: number) => void;
      const exit = new Promise<number>((resolve) => (settle = resolve));
      let exited = false;
      const end = (code: number, lastLine?: string) => {
        if (exited) return;
        exited = true;
        if (lastLine) controller.enqueue(lastLine);
        settle(code);
        if (options.closeAfterMs !== 'never') setTimeout(() => controller.close(), options.closeAfterMs);
      };
      if (options.exit !== 'on-signal') end(options.exit);
      return {
        output,
        ready: () => (options.exit === 'on-signal' ? Promise.resolve() : exit.then((code) => (code === 0 ? undefined : Promise.reject(new Error(`Exited with code ${code}.`))))),
        wait: () => exit,
        kill: (signal = 'SIGTERM') => end(signal === 'SIGKILL' ? 137 : 143, `shut down (${signal})`),
        url: () => undefined,
      };
    },
  };
}

describe('a process’s output ends after its exit, with its last line', () => {
  it('node: a last write without a newline, an immediate process.exit, and a nested child’s output relayed by its parent', { timeout: SLOW }, async () => {
    const { processes } = host({
      'last.js': "console.log('first'); process.stdout.write('last-line');",
      'exit.js': "process.stdout.write('before-exit'); process.exit(3);",
      'err.js': "process.stderr.write('to stderr, no newline'); process.exitCode = 1;",
      'pkg/package.json': JSON.stringify({ name: 'pkg', scripts: { setup: 'node finish.js' } }),
      'pkg/finish.js': "console.log('installing'); process.stdout.write('setup-done');",
    });
    expect(await outputAndExit(processes.run('node', ['last.js']))).toEqual({ output: 'first\nlast-line', code: 0 });
    expect(await outputAndExit(processes.run('node', ['exit.js']))).toEqual({ output: 'before-exit', code: 3 });
    expect(await outputAndExit(processes.run('node', ['err.js']))).toEqual({ output: 'to stderr, no newline', code: 1 });
    // `npm run setup`: npm's shell runs node as its child and exits as soon as the child does.
    const npm = await outputAndExit(processes.run('npm', ['run', 'setup'], { cwd: '/pkg' }));
    expect(npm.code).toBe(0);
    expect(npm.output.endsWith('installing\nsetup-done')).toBe(true);
    processes.dispose();
  });

  it('php: the CLI’s last echo, and composer install’s last line', { timeout: SLOW }, async () => {
    const { processes } = phpHost(
      { 'cli.php': '<?php echo "first\\n"; fwrite(STDERR, "warn\\n"); echo "last-line";', 'api/composer.json': JSON.stringify({ name: 'demo/api', require: { php: '>=8.1' }, autoload: { 'psr-4': { 'App\\': 'src/' } } }) },
      {},
      { fetch: offline },
    );
    const cli = await outputAndExit(processes.run('php', ['cli.php']));
    expect(cli.code).toBe(0);
    expect(cli.output.endsWith('last-line')).toBe(true);
    expect(cli.output).toContain('first\n');
    const composer = await outputAndExit(processes.run('composer', ['install'], { cwd: '/api' }));
    expect(composer.code, composer.output).toBe(0);
    expect(composer.output).toMatch(/autoload/i);
    processes.dispose();
  });

  it('python: a last write without a newline, and sys.exit', { timeout: SLOW }, async () => {
    const { python } = pythonHost({ 'last.py': "import sys\nprint('first')\nsys.stdout.write('last-line')\n", 'exit.py': "import sys\nsys.stderr.write('bye')\nsys.exit(4)\n" });
    expect(await outputAndExit(python.run('python', ['last.py']))).toEqual({ output: 'first\nlast-line', code: 0 });
    expect(await outputAndExit(python.run('python', ['exit.py']))).toEqual({ output: 'bye', code: 4 });
    python.dispose();
  });

  it.skipIf(!RUST_FIXTURES_DIR)('rust: a WASI module’s last stderr line before std::process::exit', { timeout: SLOW }, async () => {
    const { processes } = rustHost({ 'hello.wasm': RUST_FIXTURES_DIR ? fixture('hello.wasm') : new Uint8Array() });
    const { output, code } = await outputAndExit(processes.run('wasmtime', ['run', 'hello.wasm']));
    expect(code).toBe(0);
    const lines = output.trimEnd().split('\n');
    expect(lines[0]).toBe('hello from rust: ');
    expect(lines.at(-1)).toMatch(/^no input\.txt: /); // eprintln!, the line written just before the exit
    processes.dispose();
  });

  it.skipIf(!DOTNET_BUNDLE_DIR)('.NET: Console.Write without a newline as Main returns', { timeout: SLOW }, async () => {
    const program = 'Console.WriteLine("first");\nConsole.Error.WriteLine("warn");\nConsole.Write("last-line");\nreturn 2;\n';
    const { processes } = dotnetHost({ 'tool/app.cs': program }, loadBundledDotnet);
    const { output, code } = await outputAndExit(processes.run('dotnet', ['run', 'app.cs'], { cwd: '/tool' }));
    expect(code).toBe(2);
    expect(output).toContain('first\n');
    expect(output.endsWith('last-line')).toBe(true);
    processes.dispose();
  });

  it('pglite: the database’s log ends once it has closed', { timeout: SLOW }, async () => {
    const { processes, databases } = appHost();
    const provider = createPgliteProvider(databases, { locks: fakeLocks() });
    const handle = await provider.start(
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
      { env: { BUILDERFORCE_PROJECT_ID: `close-${Date.now()}` }, signal: new AbortController().signal, security: Object.freeze({ applicationId: 'app:close:1', serviceId: 'db' }) },
    );
    await handle.ready();
    const output = readAll(handle.output);
    handle.kill('SIGTERM');
    const [, code] = await Promise.all([output, handle.wait()]);
    expect(code).toBe(143);
    processes.dispose();
  });
});

/**
 * The service's log exactly as it stood at this instant: the history a new
 * reader is handed (enqueued as the stream is made), read synchronously, then
 * cancelled — so a line that arrives later is not in it. One read per line the
 * history can hold (`logHistory`, default 5000 — these tests keep the default), so
 * all of it is read whatever its length; reads past its end end with the cancel.
 */
function logNow(app: ApplicationRuntime, serviceId: string, history = 5000): Promise<string[]> {
  const reader = app.logs(serviceId).getReader();
  const reads = Array.from({ length: history }, () => reader.read());
  void reader.cancel();
  return Promise.all(reads).then((results) => results.flatMap((result) => (result.done ? [] : [result.value.text])));
}

/** Every state change of `serviceId`, with the log as it stood at that change. */
function logsAtChanges(app: ApplicationRuntime, serviceId: string): Array<{ change: StateChange; log: Promise<string[]> }> {
  const seen: Array<{ change: StateChange; log: Promise<string[]> }> = [];
  app.onStateChange((change) => {
    if (change.serviceId === serviceId) seen.push({ change, log: logNow(app, serviceId) });
  });
  return seen;
}

describe('app.logs(id) holds a one-off setup step’s last line before it is ready', () => {
  it('node: `npm run setup` (exit-zero) — its unterminated last line is in the log at ready and at stopped, before "Completed."', { timeout: SLOW }, async () => {
    const { processes } = host({
      'web/package.json': JSON.stringify({ name: 'web', scripts: { setup: 'node finish.js' } }),
      'web/finish.js': "console.log('installing'); process.stdout.write('setup-done');",
      'web/server.js': "require('http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT));",
    });
    const spec: ApplicationSpec = {
      projectId: `logs-${Date.now()}`,
      services: [
        { id: 'setup', type: 'application', runtime: 'node', root: '/web', command: 'npm', args: ['run', 'setup'] },
        { id: 'web', type: 'application', runtime: 'node', root: '/web', command: 'node', args: ['server.js'], port: 3000, dependsOn: ['setup'] },
      ],
    };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createNodeProvider(runtimeOf(processes))] });
    const changes = logsAtChanges(app, 'setup');
    await app.start();
    const at = async (to: string) => (await changes.find(({ change }) => change.to === to)!.log);
    expect(changes.map(({ change }) => change.to)).toEqual(['preparing', 'starting', 'ready', 'running', 'stopped']);
    const atReady = await at('ready');
    expect(atReady.slice(-2)).toEqual(['installing', 'setup-done']);
    const atStopped = await at('stopped');
    expect(atStopped.slice(-3)).toEqual(['installing', 'setup-done', 'Completed.']);
    expect(app.getService('web')?.state).toBe('running');
    await app.dispose();
    processes.dispose();
  });

  it('node: a setup step that fails — its last line is in the log before "Failed (exit)" and the failed state', { timeout: SLOW }, async () => {
    const { processes } = host({ 'web/fail.js': "console.log('resolving'); process.stdout.write('ERR! missing dependency'); process.exitCode = 1;" });
    const spec: ApplicationSpec = {
      projectId: `fail-${Date.now()}`,
      services: [{ id: 'setup', type: 'application', runtime: 'node', root: '/web', command: 'node', args: ['fail.js'], restartPolicy: 'never' }],
    };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createNodeProvider(runtimeOf(processes))] });
    const changes = logsAtChanges(app, 'setup');
    const errors: string[] = [];
    app.onError((error) => errors.push(`${error.phase}: ${error.message}`));
    await expect(app.start()).rejects.toMatchObject({ failures: [{ serviceId: 'setup', phase: 'exit', exitCode: 1 }] });
    expect(errors).toEqual(['exit: Exited with code 1.']);
    const atFailed = await changes.find(({ change }) => change.to === 'failed')!.log;
    expect(atFailed.slice(-2)).toEqual(['resolving', 'ERR! missing dependency']); // the note follows the transition's listeners
    await app.dispose();
    processes.dispose();
  });

  it('any provider: a stream that ends a moment AFTER the exit still has its last line in the log before ready, and before the failure', { timeout: SLOW }, async () => {
    // A provider whose output ends after its exit settles (piped through a transform, say): within the guarantee.
    const lateClosing = (code: number): RuntimeProvider => ({
      id: 'late',
      accepts: () => ({ ok: true }),
      start() {
        let close!: () => void;
        const output = new ReadableStream<string>({
          start(controller) {
            controller.enqueue('installing\n');
            controller.enqueue('last-line');
            close = () => controller.close();
          },
        });
        const exit = Promise.resolve(code);
        void exit.then(() => setTimeout(close, 20));
        return { output, ready: () => exit.then((exitCode) => (exitCode === 0 ? undefined : Promise.reject(new Error(`Exited with code ${exitCode}.`)))), wait: () => exit, kill: () => undefined, url: () => undefined };
      },
    });
    for (const code of [0, 1]) {
      const app = startApplicationRuntime({ projectId: 'late', services: [{ id: 'setup', type: 'application', runtime: 'late', command: 'install', restartPolicy: 'never' }] }, { runtime: stubRuntime(), providers: [lateClosing(code)] });
      const changes = logsAtChanges(app, 'setup');
      if (code === 0) await app.start();
      else await expect(app.start()).rejects.toMatchObject({ failures: [{ serviceId: 'setup', phase: 'exit', exitCode: 1 }] });
      const settledAs = code === 0 ? 'ready' : 'failed';
      expect((await changes.find(({ change }) => change.to === settledAs)!.log).slice(-2)).toEqual(['installing', 'last-line']);
      await app.dispose();
    }
  });

  it('stop and restart: a server’s shutdown line, written as it exits and ending its output a moment later, is in the log before it is `stopped`', { timeout: SLOW }, async () => {
    const provider = scriptedProvider({ exit: 'on-signal', closeAfterMs: 20 });
    const app = startApplicationRuntime({ projectId: 'stop', services: [{ id: 'api', type: 'application', runtime: 'scripted', command: 'serve', readiness: { kind: 'started' } }] }, { runtime: stubRuntime(), providers: [provider] });
    const changes = logsAtChanges(app, 'api');
    await app.start();
    await app.stop();
    const stopped = () => changes.filter(({ change }) => change.to === 'stopped');
    expect((await stopped()[0]!.log).slice(-2)).toEqual(['serving', 'shut down (SIGTERM)']);
    await app.restart('api');
    await app.restart('api'); // its stop half: the second process's shutdown line before `stopped`
    expect((await stopped()[1]!.log).slice(-2)).toEqual(['serving', 'shut down (SIGTERM)']);
    await app.dispose();
  });

  it('dispose: a live `for await (app.logs())` reader gets every service’s last line before its stream ends', { timeout: SLOW }, async () => {
    const app = startApplicationRuntime(
      { projectId: 'dispose', services: [{ id: 'api', type: 'application', runtime: 'scripted', command: 'serve', readiness: { kind: 'started' } }, { id: 'worker', type: 'application', runtime: 'scripted', command: 'work', readiness: { kind: 'started' } }] },
      { runtime: stubRuntime(), providers: [scriptedProvider({ exit: 'on-signal', closeAfterMs: 30 })] },
    );
    await app.start();
    const seen: string[] = [];
    const reading = (async () => {
      for await (const entry of app.logs()) seen.push(`${entry.serviceId}: ${entry.text}`);
    })();
    await app.dispose();
    await reading; // the stream ended — after the last lines
    expect(seen).toContain('api: shut down (SIGTERM)');
    expect(seen).toContain('worker: shut down (SIGTERM)');
  });

  it('a provider whose output NEVER ends: the service still becomes ready (or failed) one stop timeout after its exit, and the log says why', { timeout: SLOW }, async () => {
    for (const code of [0, 1]) {
      const app = startApplicationRuntime(
        { projectId: 'never', services: [{ id: 'setup', type: 'application', runtime: 'scripted', command: 'install', restartPolicy: 'never' }] },
        { runtime: stubRuntime(), providers: [scriptedProvider({ exit: code, closeAfterMs: 'never' })], stopTimeoutMs: 100 },
      );
      const changes = logsAtChanges(app, 'setup');
      const started = Date.now();
      if (code === 0) await app.start();
      else await expect(app.start()).rejects.toMatchObject({ failures: [{ serviceId: 'setup', phase: 'exit', exitCode: 1 }] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(90);
      const log = await changes.find(({ change }) => change.to === (code === 0 ? 'ready' : 'failed'))!.log;
      expect(log.slice(-2)).toEqual(['serving', `Output did not end within 100ms of the exit (code ${code}); later lines may follow.`]);
      await app.dispose(); // does not wait again: the run's bounded wait is done
    }
  });

  it('php: `composer install` (exit-zero) — its last line is in the log when it is marked ready', { timeout: SLOW }, async () => {
    const { processes } = appHost({ 'api/composer.json': JSON.stringify({ name: 'demo/api', require: { php: '>=8.1' } }) }, phpWorkers({ fetch: offline }), createPhpProcessKind());
    const spec: ApplicationSpec = {
      projectId: `composer-${Date.now()}`,
      services: [{ id: 'setup', type: 'application', runtime: 'php', root: '/api', command: 'composer', args: ['install'] }],
    };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPhpProvider(runtimeOf(processes))] });
    const changes = logsAtChanges(app, 'setup');
    await app.start();
    await app.dispose();
    const full = await logNow(app, 'setup'); // after dispose: the whole history
    const lastOutput = full.filter((text) => text !== 'Completed.').at(-1)!;
    expect(lastOutput).toBeTruthy();
    const atReady = await changes.find(({ change }) => change.to === 'ready')!.log;
    expect(atReady.at(-1)).toBe(lastOutput);
    processes.dispose();
  });
});
