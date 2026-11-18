/** W10 control 5, the env half: generated per-service logins reach backends that depend on the database, and only them. */
import { describe, expect, it } from 'vitest';
import { serviceEnv, type ServiceEnvOptions } from '../../src/app/serviceEnv.js';
import type { ApplicationSpec } from '../../src/app/spec.js';

const spec: ApplicationSpec = {
  projectId: 'p',
  services: [
    { id: 'db', type: 'database', runtime: 'pglite', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: false, password: 'static-from-spec' } },
    { id: 'api', type: 'application', runtime: 'node', dependsOn: ['db'] },
    { id: 'jobs', type: 'application', runtime: 'node' },
    { id: 'web', type: 'application', runtime: 'node', role: 'frontend', dependsOn: ['db'] },
  ],
};

describe('serviceEnv with generated database credentials', () => {
  const asked: string[] = [];
  const options: ServiceEnvOptions = {
    databaseCredentials: (database, client) => (asked.push(`${client.id}->${database.id}`), { user: `${client.id}_u`, password: `pw-${client.id}` }),
  };

  it("puts the backend's own generated login in DATABASE_URL, never the spec's static password", () => {
    const env = serviceEnv(spec, 'api', options);
    expect(env.DATABASE_URL).toBe('postgres://api_u:pw-api@localhost:5432/postgres');
    expect(env.DATABASE_URL).not.toContain('static-from-spec');
  });

  it('never asks for (or hands) a login to a frontend or a service without the dependsOn edge', () => {
    asked.length = 0;
    expect(serviceEnv(spec, 'web', options).DATABASE_URL).toBeUndefined();
    expect(serviceEnv(spec, 'jobs', options).DATABASE_URL).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
