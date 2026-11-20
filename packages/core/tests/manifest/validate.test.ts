import { describe, expect, it } from 'vitest';
import { describeManifestIssue, validateManifest, type AppManifest, type ManifestIssueCode } from '../../src/manifest/index.js';

const base = (): AppManifest => ({
  version: 1,
  resources: { db: { type: 'postgres' }, cache: { type: 'redis' } },
  services: {
    api: { runtime: 'node', command: 'npm start', port: 8000, uses: ['db'] },
    worker: { runtime: 'python', command: 'rq worker', restart: 'always' },
  },
});

/** Validate `base()` changed by `edit`; returns the issues. */
function issuesAfter(edit: (manifest: Record<string, any>) => void) {
  const manifest = base() as unknown as Record<string, any>;
  edit(manifest);
  return validateManifest(manifest as unknown as AppManifest);
}

function codes(edit: (manifest: Record<string, any>) => void): ManifestIssueCode[] {
  return issuesAfter(edit).map((issue) => issue.code);
}

describe('validateManifest', () => {
  it('passes a valid manifest', () => {
    expect(validateManifest(base())).toEqual([]);
  });

  it('checks ids with the spec id rule', () => {
    expect(issuesAfter((m) => (m.services['9api'] = { runtime: 'node', command: 'x' }))).toContainEqual(expect.objectContaining({ code: 'invalid-id', path: 'services.9api' }));
    expect(codes((m) => (m.resources['bad id'] = { type: 'mail' }))).toContain('invalid-id');
  });

  it('refuses a resource and a service with the same id', () => {
    expect(codes((m) => (m.services.db = { runtime: 'node', command: 'x' }))).toContain('duplicate-id');
  });

  it('reports unknown uses, dependsOn and job service references', () => {
    expect(issuesAfter((m) => m.services.api.uses.push('nope'))).toContainEqual(expect.objectContaining({ code: 'unknown-resource', path: 'services.api.uses', value: 'nope' }));
    expect(issuesAfter((m) => (m.services.api.dependsOn = ['ghost']))).toContainEqual(expect.objectContaining({ code: 'unknown-service', path: 'services.api.dependsOn', value: 'ghost' }));
    expect(issuesAfter((m) => (m.jobs = { j: { schedule: '* * * * *', run: { service: 'ghost', command: 'x' } } }))).toContainEqual(expect.objectContaining({ code: 'unknown-service', path: 'jobs.j.run.service' }));
    expect(issuesAfter((m) => (m.ingress = { routes: [{ path: '/', service: 'ghost' }] }))).toContainEqual(expect.objectContaining({ code: 'unknown-service', path: 'ingress.routes.0.service' }));
  });

  it("requires a redis queue's `on` to name a redis resource", () => {
    expect(codes((m) => (m.resources.q = { type: 'queue', engine: 'redis', on: 'cache' }))).toEqual([]);
    expect(issuesAfter((m) => (m.resources.q = { type: 'queue', engine: 'redis', on: 'db' }))).toContainEqual(expect.objectContaining({ code: 'invalid-queue-host', path: 'resources.q.on', value: 'db' }));
    expect(codes((m) => (m.resources.q = { type: 'queue', engine: 'redis' }))).toContain('invalid-queue-host');
  });

  it('checks port range and duplicates', () => {
    expect(issuesAfter((m) => (m.services.api.port = 0))).toContainEqual(expect.objectContaining({ code: 'invalid-port', path: 'services.api.port' }));
    expect(codes((m) => (m.services.api.port = 80.5))).toContain('invalid-port');
    expect(issuesAfter((m) => (m.services.worker.port = 8000))).toContainEqual(expect.objectContaining({ code: 'duplicate-port', value: '8000' }));
  });

  it('refuses debug on a production environment', () => {
    const issues = issuesAfter((m) => (m.environments = { prod: { target: 'aws', tier: 'production', debug: true } }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'debug-in-production', severity: 'error', path: 'environments.prod.debug' }));
    expect(codes((m) => (m.environments = { dev: { target: 'browser', tier: 'non-production', debug: true } }))).toEqual([]);
  });

  it('refuses an invoke job on a service with no port', () => {
    expect(issuesAfter((m) => (m.jobs = { j: { schedule: '*/5 * * * *', invoke: { service: 'worker', path: '/poll' } } }))).toContainEqual(
      expect.objectContaining({ code: 'invoke-without-port', path: 'jobs.j.invoke', value: 'worker' }),
    );
    expect(codes((m) => (m.jobs = { j: { schedule: '*/5 * * * *', invoke: { service: 'api', method: 'POST', path: '/poll' } } }))).toEqual([]);
  });

  it('reports an invalid cron schedule with the reason', () => {
    const issue = issuesAfter((m) => (m.jobs = { j: { schedule: '61 * * * *', run: { service: 'worker', command: 'x' } } })).find((i) => i.code === 'invalid-schedule');
    expect(issue).toMatchObject({ path: 'jobs.j.schedule', value: '61 * * * *' });
    expect(issue?.detail).toContain('minute');
  });

  it('reports an unknown time zone and a bad duration', () => {
    expect(codes((m) => (m.jobs = { j: { schedule: '0 3 * * *', timezone: 'Mars/Olympus', run: { service: 'worker', command: 'x' } } }))).toContain('invalid-timezone');
    expect(codes((m) => (m.jobs = { j: { schedule: '0 3 * * *', timeout: '10 minutes', run: { service: 'worker', command: 'x' } } }))).toContain('invalid-duration');
  });

  it('requires exactly one of run or invoke', () => {
    expect(codes((m) => (m.jobs = { j: { schedule: '0 3 * * *' } }))).toContain('missing-field');
    expect(codes((m) => (m.jobs = { j: { schedule: '0 3 * * *', run: { service: 'worker', command: 'x' }, invoke: { service: 'api', path: '/' } } }))).toContain('invalid-value');
  });

  it('reports an unknown resource type', () => {
    expect(issuesAfter((m) => (m.resources.x = { type: 'mongodb' }))).toContainEqual(expect.objectContaining({ code: 'unknown-resource-type', path: 'resources.x.type', value: 'mongodb' }));
  });

  it('reports an unknown environment target and tier', () => {
    expect(issuesAfter((m) => (m.environments = { e: { target: 'heroku', tier: 'non-production' } }))).toContainEqual(expect.objectContaining({ code: 'unknown-target', path: 'environments.e.target', value: 'heroku' }));
    expect(codes((m) => (m.environments = { e: { target: 'browser', tier: 'staging' } }))).toContain('invalid-tier');
    expect(codes((m) => (m.environments = { e: { target: 'browser' } }))).toContain('missing-field');
  });

  it('reports overrides of entries the base does not declare', () => {
    expect(issuesAfter((m) => (m.environments = { e: { target: 'browser', tier: 'non-production', overrides: { services: { ghost: { port: 1 } } } } }))).toContainEqual(
      expect.objectContaining({ code: 'unknown-override-entry', path: 'environments.e.overrides.services', value: 'ghost' }),
    );
  });

  it('warns when a frontend uses a credentialed resource', () => {
    const issues = issuesAfter((m) => (m.services.web = { runtime: 'node', command: 'x', role: 'frontend', uses: ['db'] }));
    expect(issues).toEqual([expect.objectContaining({ code: 'frontend-uses-credentials', severity: 'warning' })]);
  });

  it('reports wrong shapes instead of crashing', () => {
    expect(codes((m) => (m.services = []))).toContain('invalid-value');
    expect(codes((m) => (m.services.api = 'npm start'))).toContain('invalid-value');
    expect(codes((m) => (m.services.api.readiness = { http: '/h', port: true }))).toContain('invalid-readiness');
    expect(codes((m) => (m.services.api.readiness = { port: 'yes' }))).toContain('invalid-readiness');
    expect(codes((m) => (m.services.api.restart = 'sometimes'))).toContain('invalid-value');
    expect(codes((m) => delete m.services.api.command)).toContain('missing-field');
  });

  it('describes every issue in one line', () => {
    const issues = issuesAfter((m) => {
      m.services.api.port = 0;
      m.environments = { prod: { target: 'aws', tier: 'production', debug: true } };
    });
    for (const issue of issues) expect(describeManifestIssue(issue)).toMatch(/\S/);
    expect(describeManifestIssue(issues.find((i) => i.code === 'debug-in-production')!)).toContain('production');
  });
});
