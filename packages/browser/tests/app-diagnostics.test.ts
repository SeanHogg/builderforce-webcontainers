/**
 * `app.diagnostics()` (ROADMAP item 27, the application half), an exit's message
 * keeping why readiness failed, and a service whose output cannot be read still
 * being judged on its exit.
 */
import { describe, expect, it } from 'vitest';
import { createProviderRegistry, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { startApplicationRuntime, type ApplicationSpec, type ServiceError } from '../src/app.js';
import { DIAGNOSTIC_LOG_LINES } from '../src/app/appDiagnostics.js';
import { createServiceLogs } from '../src/app/serviceLogs.js';
import { superviseService } from '../src/app/superviseService.js';
import { fakeProvider, settle, stubRuntime, take, until } from './app-fakeProvider.js';

const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const app = (...services: ServiceSpec[]): ApplicationSpec => ({ projectId: 'diag', services });
const fast = { stopTimeoutMs: 20, restart: { backoffMs: 5 }, readinessTimeoutMs: 1000, get runtime() { return stubRuntime(); } };

describe('app.diagnostics()', () => {
  it('reports each service in start order: state, restarts and last exit code only when there are any, and its last lines (bounded)', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('web', { port: 3000, dependsOn: ['api'] }), svc('api', { port: 8000 })), { providers: [fake.provider], ...fast });
    expect(runtime.diagnostics()).toEqual({ services: [{ id: 'api', state: 'discovered', lastLines: [] }, { id: 'web', state: 'discovered', lastLines: [] }] });

    await runtime.start();
    for (let i = 1; i <= 30; i++) fake.last('api').write(`line ${i}\n`);
    fake.last('web').write('compiled\n');
    await settle();
    fake.last('api').exit(1);
    await until(() => fake.of('api').length === 2 && runtime.getService('api')?.state === 'running');

    const { services } = runtime.diagnostics();
    expect(services.map((service) => service.id)).toEqual(['api', 'web']);
    const api = services[0]!;
    expect(api).toMatchObject({ id: 'api', state: 'running', restarts: 1, lastExitCode: 1 });
    expect(api.lastLines).toHaveLength(DIAGNOSTIC_LOG_LINES);
    expect(api.lastLines.slice(-3)).toEqual(['line 30', 'Failed (exit): Exited with code 1.', 'Restarting in 5ms (on-failure, attempt 1).']);
    expect(api.lastLines[0]).toBe('line 13');
    expect(services[1]).toEqual({ id: 'web', state: 'running', lastLines: ['compiled'] });
    await runtime.dispose();
  });
});

describe('an exit before the service was ready', () => {
  /** A process that exits with `code`, its readiness failing with `reason` once it has. */
  const exitsBeforeReady = (code: number, reason: string): RuntimeProvider => ({
    id: 'fake',
    accepts: () => ({ ok: true }),
    start() {
      const exit = Promise.resolve(code);
      const output = new ReadableStream<string>({ start: (controller) => (controller.enqueue('booting\n'), controller.close()) });
      return { output, ready: () => exit.then(() => Promise.reject(new Error(reason))), wait: () => exit, kill: () => undefined, url: () => undefined };
    },
  });

  it('regression: keeps why readiness failed beside the exit code', async () => {
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000, restartPolicy: 'never' })), { providers: [exitsBeforeReady(1, 'Health check answered 503.')], ...fast });
    const errors: ServiceError[] = [];
    runtime.onError((error) => errors.push(error));
    await expect(runtime.start()).rejects.toMatchObject({ failures: [{ serviceId: 'api', phase: 'exit', exitCode: 1 }] });
    expect(errors.map((error) => error.message)).toEqual(['Exited with code 1 before ready: Health check answered 503.']);
    await runtime.dispose();
  });

  it("regression: a provider's reason that already names the exit is the message as is", async () => {
    const runtime = startApplicationRuntime(app(svc('api', { port: 8000, restartPolicy: 'never' })), { providers: [exitsBeforeReady(2, 'Exited with code 2 before opening port 8000.')], ...fast });
    const errors: string[] = [];
    runtime.onError((error) => errors.push(error.message));
    await expect(runtime.start()).rejects.toMatchObject({ failures: [{ phase: 'exit', exitCode: 2 }] });
    expect(errors).toEqual(['Exited with code 2 before opening port 8000.']);
    await runtime.dispose();
  });
});

describe('a service whose output cannot be read', () => {
  it('regression: a rejecting log pipe is noted, and the exit is still acted on', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const real = createServiceLogs();
    const logs = { ...real, pipe: () => Promise.reject(new Error('pipe broke')) };
    const errors: ServiceError[] = [];
    const service = superviseService({
      spec: svc('api', { port: 8000, restartPolicy: 'never' }),
      env: {},
      registry: createProviderRegistry([fake.provider]),
      logs,
      onStateChange: () => undefined,
      onError: (error) => errors.push(error),
      dependencies: () => [],
      readinessTimeoutMs: 1000,
      dependencyTimeoutMs: 1000,
      stopTimeoutMs: 20,
      restart: {},
      stableAfterMs: 10_000,
      security: Object.freeze({ applicationId: 'app:diag:x', serviceId: 'api' }),
    });
    await service.start();
    fake.last('api').exit(1);
    await until(() => service.snapshot().state === 'failed');
    expect(errors).toMatchObject([{ phase: 'exit', message: 'Exited with code 1.', exitCode: 1 }]);
    expect(real.recent('api', 5)).toEqual(['Output could not be read to its end: pipe broke', 'Failed (exit): Exited with code 1.']);
  });

  it('regression: a stream that cannot be read (already locked) is reported in the log; the pipe still resolves', async () => {
    const logs = createServiceLogs();
    const output = new ReadableStream<string>();
    output.getReader();
    await logs.pipe('api', output);
    const [entry] = await take(logs.stream('api'), 1);
    expect(entry).toMatchObject({ source: 'runtime', text: expect.stringContaining('Output stopped:') });
  });
});
