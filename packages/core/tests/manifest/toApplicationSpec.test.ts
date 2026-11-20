import { describe, expect, it } from 'vitest';
import { serviceEnv } from '../../src/app/serviceEnv.js';
import { validateSpec } from '../../src/app/validateSpec.js';
import { parseManifest, toApplicationSpec, type AppManifest } from '../../src/manifest/index.js';
import { DESIGN_EXAMPLE_JSON, reactNodePostgres } from './fixtures.js';

const projectId = 'proj-1';

describe('toApplicationSpec', () => {
  it('maps react + node + postgres to a spec that passes validateSpec', () => {
    const { spec, declined, issues, environment } = toApplicationSpec(reactNodePostgres(), 'local', { projectId });
    expect(issues).toEqual([]);
    expect(declined).toEqual([]);
    expect(environment?.name).toBe('local');
    expect(spec).not.toBeNull();
    expect(validateSpec(spec!)).toEqual([]);
    const byId = Object.fromEntries(spec!.services.map((service) => [service.id, service]));
    expect(byId.db).toEqual({ id: 'db', type: 'database', runtime: 'pglite', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: true } });
    expect(byId.api).toMatchObject({ type: 'application', runtime: 'node', root: '/api', port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health', timeoutMs: 30_000 } });
    expect(byId.web).toMatchObject({ role: 'frontend', dependsOn: ['api'] });
  });

  it('carries ingress routes through as service ids, and reports a route to a port-less service under ingress', () => {
    const manifest = reactNodePostgres();
    manifest.ingress = { routes: [ { path: '/api', service: 'api' }, { path: '/', service: 'web' } ] };
    const { spec, issues } = toApplicationSpec(manifest, 'local', { projectId });
    expect(issues).toEqual([]);
    expect(spec!.ingress).toEqual({ routes: [ { path: '/api', serviceId: 'api' }, { path: '/', serviceId: 'web' } ] });
    expect(toApplicationSpec(reactNodePostgres(), 'local', { projectId }).spec!.ingress).toBeUndefined();

    delete manifest.services!.web!.port;
    const broken = toApplicationSpec(manifest, 'local', { projectId });
    expect(broken.spec).toBeNull();
    expect(broken.issues).toContainEqual(expect.objectContaining({ path: 'ingress', spec: { code: 'ingress-missing-port', path: '/', serviceId: 'web' } }));
  });

  it('layers the tier variables under the service’s own env', () => {
    const manifest = reactNodePostgres();
    manifest.services!.api!.env = { NODE_ENV: 'test', EXTRA: '1' };
    const { spec } = toApplicationSpec(manifest, 'local', { projectId });
    const api = spec!.services.find((service) => service.id === 'api')!;
    expect(api.env).toMatchObject({ BUILDERFORCE_ENV: 'local', BUILDERFORCE_TIER: 'non-production', BUILDERFORCE_DEBUG: 'true', NODE_ENV: 'test', EXTRA: '1' });
    const web = spec!.services.find((service) => service.id === 'web')!;
    expect(web.env?.NODE_ENV).toBe('development');
  });

  it('gives a worker with no port and restart always `started` readiness', () => {
    const manifest = reactNodePostgres();
    manifest.services!.worker = { runtime: 'python', command: 'rq worker', restart: 'always', uses: ['db'] };
    const { spec, issues } = toApplicationSpec(manifest, 'local', { projectId });
    expect(issues).toEqual([]);
    expect(spec!.services.find((service) => service.id === 'worker')).toMatchObject({ readiness: { kind: 'started' }, restartPolicy: 'always', dependsOn: ['db'] });
  });

  it('refuses debug on a production environment', () => {
    const manifest = reactNodePostgres();
    manifest.environments!.prod!.debug = true;
    const { spec, issues } = toApplicationSpec(manifest, 'local', { projectId });
    expect(spec).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'debug-in-production', severity: 'error' }));
  });

  it('declines redis in the browser with the capability reason, and the app still runs', () => {
    const manifest = reactNodePostgres();
    manifest.resources!.cache = { type: 'redis' };
    manifest.services!.api!.uses = ['db', 'cache'];
    const { spec, declined } = toApplicationSpec(manifest, 'local', { projectId });
    expect(declined).toEqual([{ id: 'cache', reason: expect.stringContaining('arrives in a later release') }]);
    expect(spec).not.toBeNull();
    expect(spec!.services.map((service) => service.id)).not.toContain('cache');
  });

  it('never hands a frontend database credentials, even when it uses the database', () => {
    const manifest = reactNodePostgres();
    manifest.services!.web!.uses = ['db'];
    const { spec, issues } = toApplicationSpec(manifest, 'local', { projectId });
    expect(issues).toEqual([expect.objectContaining({ code: 'frontend-uses-credentials', severity: 'warning' })]);
    expect(serviceEnv(spec!, 'web').DATABASE_URL).toBeUndefined();
    expect(serviceEnv(spec!, 'api').DATABASE_URL).toBe('postgres://postgres@localhost:5432/postgres');
  });

  it('puts the database on the next free port when 5432 is taken', () => {
    const manifest = reactNodePostgres();
    manifest.services!.api!.port = 5432;
    const { spec } = toApplicationSpec(manifest, 'local', { projectId });
    expect(spec!.services.find((service) => service.id === 'db')?.port).toBe(5433);
  });

  it('runs the design example in the browser: postgres hosted, the rest declined, jobs a warning', () => {
    const { manifest } = parseManifest(DESIGN_EXAMPLE_JSON);
    const { spec, declined, issues } = toApplicationSpec(manifest!, 'local', { projectId });
    expect(spec).not.toBeNull();
    expect(declined.map((entry) => entry.id)).toEqual(['cache', 'tasks', 'files', 'mail']);
    expect(issues.map((issue) => [issue.code, issue.severity, issue.path])).toEqual([
      ['jobs-not-run', 'warning', 'jobs.nightly'],
      ['jobs-not-run', 'warning', 'jobs.poll'],
    ]);
    expect(spec!.services.find((service) => service.id === 'worker')?.readiness).toEqual({ kind: 'started' });
    expect(spec!.services.find((service) => service.id === 'api')?.env?.PYTHONDEVMODE).toBeUndefined();
    expect(spec!.services.find((service) => service.id === 'worker')?.env?.PYTHONDEVMODE).toBe('1');
  });

  it('applies the environment overrides before mapping', () => {
    const manifest = reactNodePostgres();
    manifest.environments!.local!.overrides = { services: { api: { port: 9000 } } };
    const { spec } = toApplicationSpec(manifest, 'local', { projectId });
    expect(spec!.services.find((service) => service.id === 'api')?.port).toBe(9000);
  });

  it('passes validateSpec issues through', () => {
    const manifest: AppManifest = {
      version: 1,
      services: {
        a: { runtime: 'node', command: 'x', port: 1000, dependsOn: ['b'] },
        b: { runtime: 'node', command: 'x', port: 1001, dependsOn: ['a'] },
      },
    };
    const { spec, issues } = toApplicationSpec(manifest, 'local', { projectId });
    expect(spec).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'spec', spec: expect.objectContaining({ code: 'dependency-cycle' }) }));
  });

  it('reports an unknown environment', () => {
    const { spec, issues } = toApplicationSpec(reactNodePostgres(), 'qa', { projectId });
    expect(spec).toBeNull();
    expect(issues).toEqual([expect.objectContaining({ code: 'unknown-environment' })]);
  });
});
