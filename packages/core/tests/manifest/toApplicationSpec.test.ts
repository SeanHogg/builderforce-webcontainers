import { describe, expect, it } from 'vitest';
import { serviceEnv } from '../../src/app/serviceEnv.js';
import { validateSpec } from '../../src/app/validateSpec.js';
import { parseManifest, toApplicationSpec, type AppManifest, type ManifestService } from '../../src/manifest/index.js';
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

describe('toApplicationSpec: a service command is a command line', () => {
  const serviceFor = (service: ManifestService) => {
    const { spec, issues } = toApplicationSpec({ version: 1, services: { app: service } }, 'local', { projectId });
    return { service: spec?.services.find((entry) => entry.id === 'app'), issues };
  };

  it('regression: "npm install" is the program npm with argument install, not a program named "npm install" (exit 127)', () => {
    const { service, issues } = serviceFor({ runtime: 'node', command: 'npm install' });
    expect(issues).toEqual([]);
    expect(service).toMatchObject({ command: 'npm', args: ['install'] });
  });

  it('regression: "npm run dev" keeps its words ahead of the manifest args', () => {
    const { service } = serviceFor({ runtime: 'node', command: 'npm run dev', args: ['--', '--host', '0.0.0.0'] });
    expect(service).toMatchObject({ command: 'npm', args: ['run', 'dev', '--', '--host', '0.0.0.0'] });
  });

  it('regression: a uvicorn command line on python splits into program and arguments', () => {
    const { service, issues } = serviceFor({ runtime: 'python', command: 'uvicorn main:app --host 0.0.0.0 --port 8000', port: 8000 });
    expect(issues).toEqual([]);
    expect(service).toMatchObject({ command: 'uvicorn', args: ['main:app', '--host', '0.0.0.0', '--port', '8000'] });
  });

  it('regression: a quoted program path with a space stays one word', () => {
    const { service } = serviceFor({ runtime: 'node', command: '"/opt/my tools/node" server.js \'a b\'' });
    expect(service).toMatchObject({ command: '/opt/my tools/node', args: ['server.js', 'a b'] });
  });

  it('regression: a single-word command is unchanged and gains no args', () => {
    const { service } = serviceFor({ runtime: 'node', command: 'node' });
    expect(service?.command).toBe('node');
    expect(service?.args).toBeUndefined();
    expect(serviceFor({ runtime: 'node', command: 'node', args: ['server.js'] }).service).toMatchObject({ command: 'node', args: ['server.js'] });
  });

  it('regression: a line with shell operators runs through bfsh -c for node on the browser target, unsplit', () => {
    expect(serviceFor({ runtime: 'node', command: 'npm install && npm run dev' }).service).toMatchObject({ command: 'bfsh', args: ['-c', 'npm install && npm run dev'] });
    expect(serviceFor({ runtime: 'node', command: 'PORT=3000 node server.js' }).service).toMatchObject({ command: 'bfsh', args: ['-c', 'PORT=3000 node server.js'] });
    expect(serviceFor({ runtime: 'node', command: 'node server.js > out.log' }).service).toMatchObject({ command: 'bfsh', args: ['-c', 'node server.js > out.log'] });
  });

  it('regression: a shell line with manifest args is refused, since joining them as text could swallow the args', () => {
    for (const command of ['node server.js &', 'npm i && npm start', 'node server.js;']) {
      const { service, issues } = serviceFor({ runtime: 'node', command, args: ['--port', '3000'] });
      expect(service).toBeUndefined();
      expect(issues).toContainEqual(expect.objectContaining({ code: 'shell-command-with-args', severity: 'error', path: 'services.app.args', value: command }));
    }
    // A `#` comment is dropped from a line of plain words; the args stay their own array elements after it.
    expect(serviceFor({ runtime: 'node', command: 'node server.js # dev only', args: ['--port', '3000'] })).toMatchObject({ issues: [], service: { command: 'node', args: ['server.js', '--port', '3000'] } });
  });

  it('regression: a line with shell operators on a runtime without a shell is a typed issue, not a mangled command', () => {
    const { service, issues } = serviceFor({ runtime: 'python', command: 'pip install -r requirements.txt && python app.py' });
    expect(service).toBeUndefined();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'shell-command-unsupported', severity: 'error', path: 'services.app.command', value: 'pip install -r requirements.txt && python app.py' }));
  });

  it('regression: a shell line on a non-browser target is a typed issue: bfsh exists only in the browser runtime', () => {
    const manifest: AppManifest = { version: 1, services: { app: { runtime: 'node', command: 'npm install && npm start' } }, environments: { edge: { target: 'cloudflare', tier: 'non-production' } } };
    const { spec, issues } = toApplicationSpec(manifest, 'edge', { projectId });
    expect(spec).toBeNull();
    expect(issues).toContainEqual(expect.objectContaining({ code: 'shell-command-unsupported', path: 'services.app.command', detail: expect.stringContaining('cloudflare target') }));
    // Plain words still split there.
    manifest.services!.app!.command = 'npm start';
    expect(toApplicationSpec(manifest, 'edge', { projectId }).spec!.services[0]).toMatchObject({ command: 'npm', args: ['start'] });
  });

  it('regression: an unquoted backslash the shell drops is a warning, and the spec is still produced', () => {
    for (const command of ['node .\\server.js', 'node C:\\app\\x.js']) {
      const { service, issues } = serviceFor({ runtime: 'node', command });
      expect(service).toBeDefined();
      expect(issues).toEqual([expect.objectContaining({ code: 'command-backslash', severity: 'warning', path: 'services.app.command', value: command })]);
    }
    expect(serviceFor({ runtime: 'node', command: 'node "C:\\app\\x.js"' }).issues).toEqual([]);
  });

  it('regression: escaped glob characters, URLs and bracketed IPv6 hosts are literal words, not a shell line', () => {
    expect(serviceFor({ runtime: 'node', command: 'node echo.js foo\\*' }).service).toMatchObject({ command: 'node', args: ['echo.js', 'foo*'] });
    expect(serviceFor({ runtime: 'python', command: 'uvicorn main:app --host [::] --port 8000' })).toMatchObject({ issues: [], service: { command: 'uvicorn', args: ['main:app', '--host', '[::]', '--port', '8000'] } });
    expect(serviceFor({ runtime: 'node', command: 'node fetch.js http://x/?a=1' }).service).toMatchObject({ command: 'node', args: ['fetch.js', 'http://x/?a=1'] });
    expect(serviceFor({ runtime: 'node', command: 'node lint.js src/*.js' }).service).toMatchObject({ command: 'bfsh', args: ['-c', 'node lint.js src/*.js'] });
  });

  it('regression: a backslash warning is for the effective command only, not a base command an override replaced', () => {
    const manifest: AppManifest = {
      version: 1,
      services: { app: { runtime: 'node', command: 'node .\\server.js' } },
      environments: { local: { target: 'browser', tier: 'non-production', overrides: { services: { app: { command: 'node ./server.js' } } } }, raw: { target: 'browser', tier: 'non-production' } },
    };
    expect(toApplicationSpec(manifest, 'local', { projectId }).issues).toEqual([]);
    expect(toApplicationSpec(manifest, 'raw', { projectId }).issues).toEqual([expect.objectContaining({ code: 'command-backslash', path: 'services.app.command', value: 'node .\\server.js' })]);
  });

  it('regression: a job shell line is shell-command-unsupported on a target that runs jobs and has no shell', () => {
    const manifest: AppManifest = {
      version: 1,
      services: { api: { runtime: 'node', command: 'node server.js', port: 8000 } },
      jobs: { migrate: { schedule: '0 3 * * *', run: { service: 'api', command: 'npm run migrate && npm run seed' } } },
      environments: { edge: { target: 'cloudflare', tier: 'non-production' }, local: { target: 'browser', tier: 'non-production' } },
    };
    const edge = toApplicationSpec(manifest, 'edge', { projectId });
    expect(edge.spec).toBeNull();
    expect(edge.issues).toContainEqual(expect.objectContaining({ code: 'shell-command-unsupported', path: 'jobs.migrate.run.command', detail: expect.stringContaining('cloudflare target') }));
    // The browser target does not run jobs at all: that is the jobs-not-run warning, not a shell error.
    const local = toApplicationSpec(manifest, 'local', { projectId });
    expect(local.issues.map((issue) => issue.code)).toEqual(['jobs-not-run']);
    // Plain words run anywhere.
    manifest.jobs!.migrate!.run!.command = 'npm run migrate';
    expect(toApplicationSpec(manifest, 'edge', { projectId }).issues).toEqual([]);
  });

  it('regression: an unterminated quote is an invalid-value issue, reported once', () => {
    const { issues } = serviceFor({ runtime: 'node', command: 'node "server.js' });
    expect(issues.filter((issue) => issue.code === 'invalid-value' && issue.path === 'services.app.command')).toHaveLength(1);
  });
});
