/**
 * The application runtime's half of Security Shield identity and control 9
 * (make.md › PRD 31 §4 W10): it mints one application identity, hands each
 * service's provider `(applicationId, serviceId)` in the start context, ends a
 * service's attributed processes when it stops or fails and the application's
 * when it stops, and suspends a service whose restarts loop past its policy.
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_APPLICATION, PLATFORM_APPLICATION, type ProcessOptions, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { toApplicationSpec, type AppManifest } from '@seanhogg/builderforce-webcontainers-core/manifest';
import { createNodeProvider, startApplicationRuntime, type ApplicationSpec, type NodeServiceHost, type ServiceSpec } from '../src/app.js';
import { fakeProvider, settle, stubRuntime, until } from './app-fakeProvider.js';

const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const app = (...services: ServiceSpec[]): ApplicationSpec => ({ projectId: 'p1', services });
// A fresh runtime per application started: an application's identity is stable, so one runtime holds it once at a time.
const fast = { stopTimeoutMs: 20, restart: { backoffMs: 5 }, readinessTimeoutMs: 1000, get runtime() { return stubRuntime(); } };

function recordingProcesses() {
  const kills: Array<[string, string | undefined]> = [];
  return { kills, processes: { killApplication: (applicationId: string, serviceId?: string) => void kills.push([applicationId, serviceId]) } };
}

describe('application identity', () => {
  it('mints one application identity and gives each service its own (applicationId, serviceId)', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const runtime = startApplicationRuntime(app(svc('api'), svc('web', { dependsOn: ['api'], env: { BUILDERFORCE_SERVICE: 'api' } })), { providers: [fake.provider], ...fast });
    await runtime.start();
    expect(runtime.applicationId).toMatch(/^app:p1:/);
    expect([WORKSPACE_APPLICATION, PLATFORM_APPLICATION]).not.toContain(runtime.applicationId);
    expect(fake.last('api').security).toEqual({ applicationId: runtime.applicationId, serviceId: 'api' });
    // An env claiming another service changes nothing.
    expect(fake.last('web').security).toEqual({ applicationId: runtime.applicationId, serviceId: 'web' });
    const other = startApplicationRuntime(app(svc('api')), { providers: [fake.provider], ...fast });
    expect(other.applicationId).not.toBe(runtime.applicationId);
    await runtime.dispose();
  });

  it('keeps an application its identity across starts (so its preview origin and storage), and never shares it with another application of the project', () => {
    const fake = fakeProvider();
    const shop = () => app(svc('api', { root: '/apps/shop' }), svc('web', { root: '/apps/shop/web' }));
    const first = startApplicationRuntime(shop(), { providers: [fake.provider], ...fast });
    const again = startApplicationRuntime({ ...shop(), services: [...shop().services].reverse() }, { providers: [fake.provider], ...fast });
    expect(again.applicationId).toBe(first.applicationId);
    // Another application of the same project, with the same service ids in its own directories.
    const blog = startApplicationRuntime(app(svc('api', { root: '/apps/blog' }), svc('web', { root: '/apps/blog/web' })), { providers: [fake.provider], ...fast });
    expect(blog.applicationId).not.toBe(first.applicationId);
    // The same services in another project.
    const elsewhere = startApplicationRuntime({ ...shop(), projectId: 'p2' }, { providers: [fake.provider], ...fast });
    expect(elsewhere.applicationId).not.toBe(first.applicationId);
    expect(first.applicationId).toBe('app:p1:b50454b399d7da11');
  });

  it('distinguishes named applications with identical services in one project and keeps their ids across service changes', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const options = { ...fast, providers: [{ ...fake.provider, id: 'node' }] };
    const manifest: AppManifest = { version: 1, services: { api: { runtime: 'node', root: '/apps/shared', command: 'node server.js', restart: 'always' } } };
    const specFor = (name?: string, projectId = 'p1') => toApplicationSpec({ ...manifest, name }, 'local', { projectId }).spec!;
    const shopSpec = specFor('shop');
    const shop = startApplicationRuntime(shopSpec, options);
    const blog = startApplicationRuntime(specFor('blog'), options);
    const changed = startApplicationRuntime({ ...shopSpec, services: [svc('worker')] }, options);
    const elsewhere = startApplicationRuntime(specFor('shop', 'p2'), options);
    const unnamed = startApplicationRuntime(specFor(), options);

    expect(changed.applicationId).toBe(shop.applicationId);
    expect(new Set([shop.applicationId, blog.applicationId, elsewhere.applicationId, unnamed.applicationId]).size).toBe(4);
    await shop.start();
    expect(fake.last('api').security).toEqual({ applicationId: shop.applicationId, serviceId: 'api' });
    await blog.start();
    expect(fake.last('api').security).toEqual({ applicationId: blog.applicationId, serviceId: 'api' });
    await Promise.all([shop.dispose(), blog.dispose()]);
  });

  it('only lets the handle that owns a named application stop its processes and clear its state', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const { kills, processes } = recordingProcesses();
    const forgotten: string[] = [];
    const runtime = { ...stubRuntime(), forgetApplication: (id: string) => void forgotten.push(id) };
    const options = { ...fast, runtime, processes, providers: [fake.provider] };
    const spec = { ...app(svc('api')), name: 'shop' };
    const first = startApplicationRuntime(spec, options);
    const duplicate = startApplicationRuntime(spec, options);
    const next = startApplicationRuntime(spec, options);

    await first.start();
    await expect(duplicate.start()).rejects.toThrow('already registered');
    await expect(duplicate.restart('api')).rejects.toThrow('already registered');
    await duplicate.dispose();
    expect(kills).toEqual([]);
    expect(forgotten).toEqual([]);

    await first.stop();
    await next.start();
    await first.dispose();
    expect(kills).toEqual([[next.applicationId, 'api'], [next.applicationId, undefined]]);
    expect(forgotten).toEqual([next.applicationId]);
    await next.dispose();
  });

  it('the node provider spawns, and probes readiness, as the service, from its directory', async () => {
    const runs: Array<{ command: string; options?: ProcessOptions & { identity?: SecurityContext } }> = [];
    const callers: Array<SecurityContext | undefined> = [];
    let listening: ((server: { port: number; url: string }) => void) | undefined;
    const host: NodeServiceHost = {
      run(command, _args, options) {
        runs.push({ command, options });
        queueMicrotask(() => listening?.({ port: 8000, url: 'https://app.test/__port/8000/' }));
        return { pid: 1, combinedOutput: new ReadableStream(), wait: () => new Promise(() => undefined), kill: () => undefined } as never;
      },
      onServerListening: (listener) => ((listening = listener), () => undefined),
      onPortChange: () => () => undefined,
      request: async (_port, _request, caller) => (callers.push(caller), { status: 200 }),
    };
    const runtime = startApplicationRuntime(app(svc('api', { runtime: 'node', command: 'node', args: ['server.js'], root: '/apps/api', port: 8000, readiness: { kind: 'http', path: '/health' } })), {
      providers: [createNodeProvider(host, { probeIntervalMs: 1 })],
      ...fast,
    });
    await runtime.start();
    const identity = { applicationId: runtime.applicationId, serviceId: 'api' };
    expect(runs[0]!.options).toMatchObject({ identity, cwd: '/apps/api' });
    expect(callers[0]).toEqual(identity);
  });
});

describe('attributed processes (control 9)', () => {
  it("stopping a service ends its attributed processes; stopping the application ends the application's", async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const { kills, processes } = recordingProcesses();
    const runtime = startApplicationRuntime(app(svc('api'), svc('web', { dependsOn: ['api'] })), { providers: [fake.provider], processes, ...fast });
    await runtime.start();
    await runtime.restart('web');
    expect(kills).toEqual([[runtime.applicationId, 'web']]);
    await runtime.stop();
    expect(kills.slice(1)).toEqual([
      [runtime.applicationId, 'web'],
      [runtime.applicationId, 'api'],
      [runtime.applicationId, undefined],
    ]);
  });

  it("a failed service's attributed processes are ended before it restarts", async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const { kills, processes } = recordingProcesses();
    const runtime = startApplicationRuntime(app(svc('api')), { providers: [fake.provider], processes, ...fast });
    await runtime.start();
    fake.last('api').exit(1);
    await until(() => fake.of('api').length === 2);
    expect(kills).toEqual([[runtime.applicationId, 'api']]);
    await runtime.dispose();
  });
});

describe('restart loops (control 9)', () => {
  it('a service that keeps crashing after it is ready is suspended at the restart limit, not restarted forever', async () => {
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(app(svc('api')), { providers: [fake.provider], ...fast, restart: { backoffMs: 1, maxRestarts: 3 }, stableAfterMs: 60_000 });
    await runtime.start();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await until(() => fake.of('api').length === attempt && runtime.getService('api')?.state === 'running');
      fake.last('api').exit(1);
    }
    await until(() => runtime.getService('api')?.state === 'failed');
    await settle(10);
    expect(fake.of('api')).toHaveLength(4);
    expect(runtime.getService('api')).toMatchObject({ state: 'failed', restarts: 3, error: { willRestart: false } });
  });
});
