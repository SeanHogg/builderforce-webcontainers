/** Stops and restarts racing starts, readiness waits and backoffs, and the end of the runtime. */
import { describe, expect, it } from 'vitest';
import { ApplicationStartError, startApplicationRuntime, type ApplicationSpec, type ServiceError, type ServiceSpec } from '../src/app.js';
import { stopProcess } from '../src/app/stopService.js';
import { fakeProvider, gate, settle, stubRuntime, until } from './app-fakeProvider.js';

const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const app = (...services: ServiceSpec[]): ApplicationSpec => ({ projectId: 'p1', services });
// A fresh runtime per application started: an application's identity is stable, so one runtime holds it once at a time.
const fast = { stopTimeoutMs: 20, restart: { backoffMs: 5 }, readinessTimeoutMs: 1000, get runtime() { return stubRuntime(); } };
const failureOf = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as ApplicationStartError);

describe('stopping and restarting while things are in flight', () => {
  it('stop during preparing/starting cancels the start: not a failure, no error, nothing left running', async () => {
    const fake = fakeProvider();
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast });
    const errors: ServiceError[] = [];
    runtime.onError((error) => errors.push(error));
    const started = runtime.start();
    await until(() => fake.of('api').length === 1);
    expect(runtime.getService('api')?.state).toBe('starting');
    expect(runtime.getService('web')?.state).toBe('preparing');

    await runtime.stop();
    await expect(started).resolves.toBeUndefined();
    expect(errors).toEqual([]);
    expect(fake.last('api').signals).toEqual(['SIGTERM']);
    expect(fake.of('web')).toHaveLength(0);
    expect(runtime.listServices().map((s) => s.state)).toEqual(['stopped', 'stopped']);
  });

  it('stop while the provider is still starting the process waits for it, then stops it cooperatively', async () => {
    const hold = gate();
    const fake = fakeProvider({ startGate: () => hold.promise });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast, stopTimeoutMs: 500 });
    const started = runtime.start();
    await until(() => runtime.getService('api')?.state === 'starting');
    const stopped = runtime.stop();
    await settle();
    hold.open();
    await stopped;
    await started;
    expect(fake.last('api').signals).toEqual(['SIGTERM']);
    expect(runtime.getService('api')?.state).toBe('stopped');
  });

  it('a process the provider delivers after the stop gave up waiting is killed when it arrives', async () => {
    const hold = gate();
    const fake = fakeProvider({ startGate: () => hold.promise });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast });
    void runtime.start();
    await until(() => runtime.getService('api')?.state === 'starting');
    await runtime.stop();
    expect(runtime.getService('api')?.state).toBe('stopped');
    hold.open();
    await until(() => fake.started.length === 1 && fake.last('api').exited);
    expect(fake.last('api').signals).toEqual(['SIGKILL']);
    expect(runtime.getService('api')?.state).toBe('stopped');
  });

  it('stop during a restart backoff cancels the restart', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast, restart: { backoffMs: 100 } });
    await runtime.start();
    fake.last('api').exit(1);
    await until(() => runtime.getService('api')?.state === 'failed');
    await runtime.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.of('api')).toHaveLength(1);
    expect(runtime.getService('api')?.state).toBe('stopped');
  });

  it('restart(dependency) while a dependent waits for it: the dependent keeps waiting, then starts', async () => {
    const fake = fakeProvider({ autoReady: ['web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast });
    const started = runtime.start();
    await until(() => fake.of('api').length === 1);
    const restarted = runtime.restart('api');
    await until(() => fake.of('api').length === 2);
    expect(runtime.getService('web')?.state).toBe('preparing');
    fake.last('api').markReady();
    await restarted;
    await started;
    expect(runtime.getService('web')?.state).toBe('running');
    expect(fake.of('web')).toHaveLength(1);
  });

  it('restart before start and after stop fails fast when a dependency is not running, and works when it is', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast });
    const before = await failureOf(runtime.restart('web'));
    expect(before?.failures).toEqual([{ serviceId: 'web', phase: 'dependency', message: 'Dependency "api" is not available: Not started.', willRestart: false }]);

    await runtime.restart('api');
    await runtime.restart('web');
    expect(runtime.getService('web')?.state).toBe('running');

    await runtime.stop();
    const after = await failureOf(runtime.restart('web'));
    expect(after?.failures[0]).toMatchObject({ serviceId: 'web', phase: 'dependency', message: 'Dependency "api" is not available: Stopped.' });
  });

  it('a stop racing a restart wins: the restart does not start the service again after the stop', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    fake.stubborn.add('api'); // ignores SIGTERM, so the restart's stop sits in its grace period
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast });
    await runtime.start();
    const restarted = runtime.restart('api');
    await settle(1);
    const stopped = runtime.stop();
    await Promise.all([restarted, stopped]);
    await settle();
    expect(fake.of('api')).toHaveLength(1);
    expect(fake.last('api').signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(runtime.getService('api')?.state).toBe('stopped');
  });

  it('a dependency that is stopping is not ready: a dependent starting meanwhile fails instead of starting', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    fake.stubborn.add('api'); // a long SIGTERM grace
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast, stopTimeoutMs: 200 });
    await runtime.start();
    const stopped = runtime.stop();
    await until(() => runtime.getService('api')?.state === 'stopping');
    const failure = await failureOf(runtime.restart('web'));
    expect(failure?.failures[0]).toMatchObject({ serviceId: 'web', phase: 'dependency', message: 'Dependency "api" is not available: Stopped.' });
    expect(fake.of('web')).toHaveLength(1);
    await stopped;
  });

  it('dispose() stops everything and ends every logs() stream; the runtime cannot start again', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast });
    await runtime.start();
    const reader = runtime.logs().getReader();
    await runtime.dispose();
    for (;;) if ((await reader.read()).done) break;
    expect(runtime.getService('api')?.state).toBe('stopped');
    await expect(runtime.start()).rejects.toThrow('disposed');
  });

  it('a logs() reader that falls behind loses the overflow and is told how much', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast, logReaderBuffer: 3 });
    await runtime.start();
    const reader = runtime.logs('api').getReader();
    // Nobody reads: two lines fit (one slot stays free for the "dropped" line), eight are dropped.
    fake.last('api').write(Array.from({ length: 10 }, (_, i) => `l${i}\n`).join(''));
    await settle();
    const texts: string[] = [];
    for (let i = 0; i < 2; i++) texts.push((await reader.read()).value!.text);
    // Caught up: the next line arrives, announced by the count of what was lost.
    fake.last('api').write('l10\n');
    await settle();
    for (let i = 0; i < 2; i++) texts.push((await reader.read()).value!.text);
    await reader.cancel();
    expect(texts).toEqual(['l0', 'l1', '8 log lines dropped (reader fell behind).', 'l10']);
  });
});

describe('the checkpoint stop deadline', () => {
  /** A process that exits only on SIGKILL (137), or at `exitAfterMs`. */
  function stubborn(checkpoint: () => Promise<void>, exitAfterMs?: number) {
    const signals: string[] = [];
    let exit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (exit = resolve));
    if (exitAfterMs !== undefined) setTimeout(() => exit(0), exitAfterMs);
    return { signals, handle: { kill: (signal = 'SIGTERM') => (signals.push(signal), signal === 'SIGKILL' && exit(137)), wait: () => exited, checkpoint } };
  }

  it('the checkpoint request and the exit it asks for share ONE timeoutMs, then SIGTERM, then SIGKILL', async () => {
    const { signals, handle } = stubborn(() => new Promise<void>((resolve) => setTimeout(resolve, 120)));
    const started = Date.now();
    expect(await stopProcess(handle, 200)).toBe(137);
    const elapsed = Date.now() - started;
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    // 200 (checkpoint + its exit) + 200 (SIGTERM): SIGKILL near 400ms — not 120 + 200 + 200 with separate deadlines.
    expect(elapsed).toBeGreaterThanOrEqual(390);
    expect(elapsed).toBeLessThan(500);
  });

  it('a checkpoint request that never settles does not hold the stop past the deadline; an exit within it is the result', async () => {
    const { signals, handle } = stubborn(() => new Promise<void>(() => undefined), 50);
    expect(await stopProcess(handle, 200)).toBe(0);
    expect(signals).toEqual([]);
    const hung = stubborn(() => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await stopProcess(hung.handle, 100)).toBe(137);
    expect(Date.now() - started).toBeLessThan(290);
    expect(hung.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
