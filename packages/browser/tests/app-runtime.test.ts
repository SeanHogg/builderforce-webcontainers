import { describe, expect, it } from 'vitest';
import { ApplicationSpecError, ApplicationStartError, startApplicationRuntime, type ApplicationSpec, type ServiceError, type ServiceSpec } from '../src/app.js';
import { fakeProvider, settle, take, until } from './app-fakeProvider.js';

const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const app = (...services: ServiceSpec[]): ApplicationSpec => ({ projectId: 'p1', services });
const fast = { stopTimeoutMs: 20, restart: { backoffMs: 5 }, readinessTimeoutMs: 1000 };

describe('startApplicationRuntime', () => {
  it('validates the spec up front', () => {
    const fake = fakeProvider();
    expect(() => startApplicationRuntime(app(svc('web', { dependsOn: ['api'] })), { providers: [fake.provider] })).toThrow(ApplicationSpecError);
  });

  it('starts each service only after its dependencies are ready, with its own env', async () => {
    const fake = fakeProvider();
    const runtime = startApplicationRuntime(app(svc('web', { port: 3000, dependsOn: ['api'] }), svc('api', { port: 8000, dependsOn: ['db'] }), svc('db', { port: 9000 })), { providers: [fake.provider], ...fast });
    const started = runtime.start();
    await settle();
    expect(fake.started.map((p) => p.service.id)).toEqual(['db']);
    expect(runtime.getService('api')?.state).toBe('preparing');

    fake.last('db').markReady();
    await until(() => fake.of('api').length === 1);
    expect(fake.of('web')).toHaveLength(0);
    expect(fake.last('api').env).toMatchObject({ BUILDERFORCE_SERVICE: 'api', BUILDERFORCE_PROJECT_ID: 'p1', PORT: '8000', WEB_URL: 'http://localhost:3000' });

    fake.last('api').markReady();
    await until(() => fake.of('web').length === 1);
    fake.last('web').markReady();
    await started;
    expect(runtime.listServices().map((s) => [s.id, s.state])).toEqual([
      ['db', 'running'],
      ['api', 'running'],
      ['web', 'running'],
    ]);
    expect(runtime.getUrl('web')).toBe('https://preview.test/__port/3000/');
    expect(runtime.getUrl('nope')).toBeUndefined();
  });

  it('reports every state change in order', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 })), { providers: [fake.provider], ...fast });
    const changes: string[] = [];
    runtime.onStateChange(({ serviceId, to }) => changes.push(`${serviceId}:${to}`));
    await runtime.start();
    await runtime.stop();
    expect(changes).toEqual(['api:preparing', 'api:starting', 'api:ready', 'api:running', 'api:stopping', 'api:stopped']);
  });

  it('restarts a failed service under on-failure without touching its running dependent', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast });
    const errors: ServiceError[] = [];
    runtime.onError((error) => errors.push(error));
    await runtime.start();

    fake.last('api').exit(1);
    await until(() => fake.of('api').length === 2 && runtime.getService('api')?.state === 'running');
    expect(errors).toEqual([{ serviceId: 'api', phase: 'exit', message: 'Exited with code 1.', exitCode: 1, willRestart: true }]);
    expect(runtime.getService('api')).toMatchObject({ restarts: 1, exitCode: 1, error: undefined });
    expect(fake.of('web')).toHaveLength(1);
    expect(fake.last('web').signals).toEqual([]);
    expect(runtime.getService('web')?.state).toBe('running');
  });

  it('leaves a service failed under the never policy; unrelated services keep running', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000, restartPolicy: 'never' }), svc('web', { port: 3000 })), { providers: [fake.provider], ...fast });
    await runtime.start();
    fake.last('api').exit(2);
    await until(() => runtime.getService('api')?.state === 'failed');
    await settle();
    expect(fake.of('api')).toHaveLength(1);
    expect(runtime.getService('api')?.error).toMatchObject({ phase: 'exit', exitCode: 2, willRestart: false });
    expect(runtime.getService('web')?.state).toBe('running');
  });

  it('restarts after a clean exit only under always', async () => {
    const fake = fakeProvider({ autoReady: ['a', 'b'] });
    const runtime = startApplicationRuntime(app(svc('a', { port: 1, restartPolicy: 'always' }), svc('b', { port: 2 })), { providers: [fake.provider], ...fast });
    await runtime.start();
    fake.last('a').exit(0);
    fake.last('b').exit(0);
    await until(() => fake.of('a').length === 2 && runtime.getService('a')?.state === 'running');
    expect(runtime.getService('b')?.state).toBe('stopped');
    expect(fake.of('b')).toHaveLength(1);
  });

  it('gives up after the restart limit: start() names the failure, dependents fail, unrelated services run', async () => {
    const fake = fakeProvider({ autoReady: ['worker'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] }), svc('worker', { port: 4000 })), {
      providers: [fake.provider],
      ...fast,
      restart: { backoffMs: 1, maxRestarts: 2 },
    });
    const errors: ServiceError[] = [];
    runtime.onError((error) => errors.push(error));
    const started = runtime.start();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => fake.of('api').length === attempt);
      fake.last('api').exit(1);
    }
    const failure = await started.then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationStartError);
    expect((failure as ApplicationStartError).failures.map((f) => [f.serviceId, f.phase])).toEqual([
      ['api', 'exit'],
      ['web', 'dependency'],
    ]);
    expect(errors.filter((e) => e.serviceId === 'api').map((e) => e.willRestart)).toEqual([true, true, false]);
    expect(runtime.getService('api')?.state).toBe('failed');
    expect(runtime.getService('web')?.state).toBe('failed');
    expect(fake.of('web')).toHaveLength(0);
    expect(runtime.getService('worker')?.state).toBe('running');
  });

  it('starts nothing when any service is declined: the reason, never a half-started app', async () => {
    const fake = fakeProvider({ autoReady: ['web'] });
    const runtime = startApplicationRuntime(app(svc('ml', { runtime: 'python' }), svc('web', { port: 3000 })), { providers: [fake.provider], ...fast });
    const errors: ServiceError[] = [];
    runtime.onError((error) => errors.push(error));
    const failure = (await runtime.start().catch((error: unknown) => error)) as ApplicationStartError;
    expect(failure).toBeInstanceOf(ApplicationStartError);
    expect(failure.failures).toEqual([{ serviceId: 'ml', phase: 'declined', message: 'No runtime provider for "python" (available: fake).', willRestart: false }]);
    expect(errors).toEqual(failure.failures);
    expect(fake.started).toHaveLength(0);
    expect(runtime.listServices().map((s) => s.state)).toEqual(['discovered', 'discovered']);
  });

  it('fails a service that is not ready in time, and kills its process', async () => {
    const fake = fakeProvider();
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000, restartPolicy: 'never', readiness: { kind: 'port', timeoutMs: 20 } })), { providers: [fake.provider], ...fast });
    const failure = (await runtime.start().catch((error: unknown) => error)) as ApplicationStartError;
    expect(failure.failures[0]).toMatchObject({ serviceId: 'api', phase: 'readiness', message: 'Not ready after 20ms (port readiness).' });
    expect(fake.last('api').signals).toEqual(['SIGKILL']);
  });

  it('treats a one-off exit-zero service as ready when it finishes', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('migrate'), svc('api', { port: 8000, dependsOn: ['migrate'] })), { providers: [fake.provider], ...fast });
    const started = runtime.start();
    await until(() => fake.of('migrate').length === 1);
    expect(fake.of('api')).toHaveLength(0);
    // No markReady: the exit itself is the readiness, whatever the provider's ready() does.
    fake.last('migrate').exit(0);
    await started;
    expect(runtime.getService('migrate')?.state).toBe('stopped');
    expect(runtime.getService('api')?.state).toBe('running');
    expect(fake.of('migrate')).toHaveLength(1);
  });

  it('stops dependents first, asking politely, then SIGKILL after the stop timeout', async () => {
    const fake = fakeProvider({ autoReady: ['db', 'api', 'web', 'other'] });
    const runtime = startApplicationRuntime(
      app(svc('web', { port: 3000, dependsOn: ['api'] }), svc('other', { port: 4000 }), svc('api', { port: 8000, dependsOn: ['db'] }), svc('db', { port: 9000 })),
      { providers: [fake.provider], ...fast },
    );
    await runtime.start();
    fake.stubborn.add('api');
    // `stubborn` applies to processes started after it is set: restart api to pick it up.
    await runtime.restart('api');
    fake.kills.length = 0;
    await runtime.stop();
    // Start order is other, db, api, web (ties in spec order); stop is its reverse.
    expect(fake.kills).toEqual(['SIGTERM web', 'SIGTERM api', 'SIGKILL api', 'SIGTERM db', 'SIGTERM other']);
    expect(runtime.listServices().every((s) => s.state === 'stopped')).toBe(true);
  });

  it('restart(id) replaces one service and leaves its dependents alone', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })), { providers: [fake.provider], ...fast });
    await runtime.start();
    await runtime.restart('api');
    expect(fake.of('api')).toHaveLength(2);
    expect(fake.of('api')[0]!.signals).toEqual(['SIGTERM']);
    expect(fake.of('web')).toHaveLength(1);
    expect(runtime.getService('api')?.state).toBe('running');
    await expect(runtime.restart('nope')).rejects.toThrow('No service "nope"');
  });

  it('merges logs per service as lines, replays history to late readers, and filters by service', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000 }), svc('web', { port: 3000 })), { providers: [fake.provider], ...fast });
    await runtime.start();
    fake.last('api').write('api one\napi tw');
    fake.last('web').write('web one\n');
    fake.last('api').write('o\n');
    await settle();

    const all = await take(runtime.logs(), 3);
    expect(all.map((e) => `${e.serviceId}|${e.source}|${e.text}`)).toEqual(['api|output|api one', 'web|output|web one', 'api|output|api two']);

    const apiOnly = runtime.logs('api');
    fake.last('api').write('api three\n');
    fake.last('web').write('web two\n');
    expect((await take(apiOnly, 3)).map((e) => e.text)).toEqual(['api one', 'api two', 'api three']);

    // A restart's output continues the same service log; the runtime notes the failure.
    fake.last('api').exit(1);
    await until(() => fake.of('api').length === 2);
    fake.last('api').write('api again\n');
    await settle();
    const after = await take(runtime.logs('api'), 6);
    expect(after.map((e) => `${e.source}|${e.text}`)).toEqual([
      'output|api one',
      'output|api two',
      'output|api three',
      'runtime|Failed (exit): Exited with code 1.',
      'runtime|Restarting in 5ms (on-failure, attempt 1).',
      'output|api again',
    ]);
  });
});
