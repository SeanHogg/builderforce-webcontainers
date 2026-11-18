import { describe, expect, it } from 'vitest';
import {
  ApplicationSpecError,
  assertValidSpec,
  createLifecycle,
  IllegalTransitionError,
  restartDecision,
  serviceEnv,
  serviceGraph,
  validateSpec,
  type ApplicationSpec,
  type ServiceSpec,
} from '../../src/app/index.js';

const app = (...services: ServiceSpec[]): ApplicationSpec => ({ projectId: 'p1', services });
const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'node', command: 'node', args: [`${id}.js`], ...extra });

describe('validateSpec', () => {
  it('accepts a valid spec', () => {
    expect(validateSpec(app(svc('api', { port: 8000 }), svc('web', { port: 3000, dependsOn: ['api'] })))).toEqual([]);
  });

  it('reports unknown dependencies, duplicate ids and ports, and invalid ids as typed issues', () => {
    const issues = validateSpec(
      app(
        svc('api', { port: 8000 }),
        svc('api', { port: 8001 }),
        svc('web', { port: 8000, dependsOn: ['nope'] }),
        svc('bad id'),
      ),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { code: 'duplicate-service', serviceId: 'api' },
        { code: 'duplicate-port', port: 8000, serviceIds: ['api', 'web'] },
        { code: 'unknown-dependency', serviceId: 'web', dependency: 'nope' },
        { code: 'invalid-id', serviceId: 'bad id' },
      ]),
    );
    expect(issues).toHaveLength(4);
  });

  it('reports a cycle once, starting at its first service, including a self-dependency', () => {
    expect(validateSpec(app(svc('a', { dependsOn: ['c'] }), svc('b', { dependsOn: ['a'] }), svc('c', { dependsOn: ['b'] })))).toEqual([{ code: 'dependency-cycle', cycle: ['a', 'c', 'b'] }]);
    expect(validateSpec(app(svc('a', { dependsOn: ['a'] })))).toEqual([{ code: 'dependency-cycle', cycle: ['a'] }]);
  });

  it('reports missing ports for port/http readiness, missing commands, missing database settings and invalid ports', () => {
    const issues = validateSpec(
      app(
        svc('api', { readiness: { kind: 'http', path: '/health' } }),
        { id: 'job', type: 'application', runtime: 'node' },
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' } },
        svc('web', { port: 70000 }),
      ),
    );
    expect(issues).toEqual([
      { code: 'missing-port', serviceId: 'api', readiness: 'http' },
      { code: 'missing-command', serviceId: 'job' },
      { code: 'missing-database', serviceId: 'db' },
      { code: 'invalid-port', serviceId: 'web', port: 70000 },
    ]);
  });

  it('assertValidSpec throws ApplicationSpecError carrying the issues', () => {
    const spec = app(svc('web', { dependsOn: ['api'] }));
    expect(() => assertValidSpec(spec)).toThrow(ApplicationSpecError);
    try {
      assertValidSpec(spec);
    } catch (error) {
      expect((error as ApplicationSpecError).issues).toEqual([{ code: 'unknown-dependency', serviceId: 'web', dependency: 'api' }]);
      expect((error as Error).message).toContain('depends on "api"');
    }
  });
});

describe('serviceGraph', () => {
  it('orders a diamond: the shared dependency first, the join last, ties in spec order', () => {
    //   db  <- api  <- web
    //   db  <- jobs <- web
    const graph = serviceGraph(
      app(svc('web', { dependsOn: ['api', 'jobs'] }), svc('jobs', { dependsOn: ['db'] }), svc('api', { dependsOn: ['db'] }), svc('db')),
    );
    expect(graph.startOrder).toEqual(['db', 'jobs', 'api', 'web']);
    expect(graph.stopOrder).toEqual(['web', 'api', 'jobs', 'db']);
    expect(graph.dependenciesOf('web')).toEqual(['api', 'jobs']);
    expect(graph.dependentsOf('db')).toEqual(['jobs', 'api', 'web']);
    expect(graph.dependentsOf('api')).toEqual(['web']);
    expect(graph.dependentsOf('web')).toEqual([]);
  });

  it('keeps spec order for independent services and throws on an invalid spec', () => {
    expect(serviceGraph(app(svc('b'), svc('a'), svc('c'))).startOrder).toEqual(['b', 'a', 'c']);
    expect(() => serviceGraph(app(svc('a', { dependsOn: ['b'] }), svc('b', { dependsOn: ['a'] })))).toThrow(ApplicationSpecError);
  });
});

describe('lifecycle', () => {
  it('walks discovered → … → stopped, reporting each change, and restarts through preparing', () => {
    const changes: string[] = [];
    const life = createLifecycle('api', ({ from, to }) => changes.push(`${from}>${to}`));
    for (const to of ['preparing', 'starting', 'ready', 'running', 'stopping', 'stopped', 'preparing'] as const) life.transition(to);
    expect(life.state).toBe('preparing');
    expect(changes).toEqual(['discovered>preparing', 'preparing>starting', 'starting>ready', 'ready>running', 'running>stopping', 'stopping>stopped', 'stopped>preparing']);
  });

  it('fails from any active state and recovers through preparing', () => {
    const life = createLifecycle('api');
    life.transition('preparing');
    life.transition('failed');
    life.transition('preparing');
    expect(life.state).toBe('preparing');
  });

  it('throws IllegalTransitionError for a transition the table does not list, leaving the state as it was', () => {
    const life = createLifecycle('api');
    expect(() => life.transition('running')).toThrow(IllegalTransitionError);
    expect(() => life.transition('stopped')).toThrow('cannot go from "discovered" to "stopped"');
    expect(life.state).toBe('discovered');
  });
});

describe('serviceEnv', () => {
  const spec: ApplicationSpec = {
    projectId: 'proj-7',
    env: { SHARED: '1', API_URL: 'overridden by the service map' },
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: true, name: 'app', password: 'p@ss' } },
      svc('api', { port: 8000, dependsOn: ['db'] }),
      svc('web', { port: 3000, role: 'frontend', dependsOn: ['api', 'db'], env: { SHARED: 'mine' } }),
    ],
  };

  it('injects the service map, identity and port', () => {
    const env = serviceEnv(spec, 'api');
    expect(env).toMatchObject({ SHARED: '1', API_URL: 'http://localhost:8000', WEB_URL: 'http://localhost:3000', BUILDERFORCE_SERVICE: 'api', BUILDERFORCE_PROJECT_ID: 'proj-7', PORT: '8000' });
    expect(env.DB_URL).toBeUndefined(); // databases are reached by DATABASE_URL, not an HTTP URL
  });

  it('gives a backend the connection URL of the database it depends on', () => {
    const env = serviceEnv(spec, 'api');
    expect(env.DATABASE_URL).toBe('postgres://postgres:p%40ss@localhost:5432/app');
    expect(env.DB_DATABASE_URL).toBe(env.DATABASE_URL);
  });

  it('never gives a frontend database credentials, even when it depends on the database; its own env wins', () => {
    const env = serviceEnv(spec, 'web');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.DB_DATABASE_URL).toBeUndefined();
    expect(env.API_URL).toBe('http://localhost:8000');
    expect(env.SHARED).toBe('mine');
  });

  it('throws for an unknown service', () => {
    expect(() => serviceEnv(spec, 'nope')).toThrow('No service "nope"');
  });
});

describe('restartDecision', () => {
  it('follows the policy, backs off, and stops at the limit', () => {
    expect(restartDecision('never', 'port', 1, 0)).toEqual({ restart: false, reason: 'policy' });
    expect(restartDecision('on-failure', 'port', 0, 0)).toEqual({ restart: false, reason: 'policy' });
    expect(restartDecision('on-failure', 'port', 1, 0)).toEqual({ restart: true, delayMs: 250 });
    expect(restartDecision('always', 'port', 0, 2)).toEqual({ restart: true, delayMs: 1000 });
    expect(restartDecision('always', 'port', 1, 10, { maxRestarts: 20 })).toEqual({ restart: true, delayMs: 5000 });
    expect(restartDecision('always', 'port', 1, 5)).toEqual({ restart: false, reason: 'limit' });
    expect(restartDecision('always', 'exit-zero', 0, 0)).toEqual({ restart: false, reason: 'completed' });
  });
});
