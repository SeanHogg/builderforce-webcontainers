/**
 * The environment one service starts with. Layers, later winning:
 *   1. the application's `env` (without database credentials for a role that may not hold them);
 *   2. the project-scoped service map — `<ID>_URL=http://localhost:<port>` for
 *      every application service with a port (`API_URL` for a service `api`);
 *   3. the service's identity: `BUILDERFORCE_SERVICE`, `BUILDERFORCE_PROJECT_ID`, `PORT`;
 *   4. database connection URLs for the databases it depends on, when its role
 *      may hold credentials (`CREDENTIAL_POLICY`): `<DB>_DATABASE_URL` for each,
 *      and `DATABASE_URL` only when it depends on exactly one database;
 *   5. the service's own `env`.
 * App code sees only localhost addresses — never worker ids or preview URLs.
 */
import { roleOf, type ApplicationSpec, type DatabaseSpec, type ServiceRole, type ServiceSpec } from './spec.js';

/** Which roles may receive database credentials. A frontend's code ships to the browser, so it may not. */
export const CREDENTIAL_POLICY: Readonly<Record<ServiceRole, { databaseCredentials: boolean }>> = {
  frontend: { databaseCredentials: false },
  backend: { databaseCredentials: true },
};

/** Connection URL scheme per database engine; an engine not listed gets no URL. */
export const DATABASE_URL_SCHEMES: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mongodb: 'mongodb',
};

/** `web-app` → `WEB_APP`. */
export function envName(serviceId: string): string {
  return serviceId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** `<ID>_URL` for every application service with a port. */
export function serviceMap(spec: ApplicationSpec): Record<string, string> {
  const map: Record<string, string> = {};
  for (const service of spec.services) {
    if (service.type === 'application' && service.port !== undefined) map[`${envName(service.id)}_URL`] = `http://localhost:${service.port}`;
  }
  return map;
}

/** `postgres://user:password@localhost:<port>/<name>`, or undefined for an engine without a URL scheme or a database without a port. */
export function databaseUrl(service: ServiceSpec, database: DatabaseSpec): string | undefined {
  const scheme = DATABASE_URL_SCHEMES[database.engine.toLowerCase()];
  if (!scheme || service.port === undefined) return undefined;
  const user = encodeURIComponent(database.user ?? 'postgres');
  const password = encodeURIComponent(database.password ?? 'postgres');
  return `${scheme}://${user}:${password}@localhost:${service.port}/${encodeURIComponent(database.name ?? service.id)}`;
}

/** May this service receive database credentials? */
export function receivesDatabaseCredentials(service: ServiceSpec): boolean {
  if (service.type === 'database') return false;
  return CREDENTIAL_POLICY[roleOf(service)].databaseCredentials;
}

/** Every connection URL the spec's databases would hand out. */
function generatedDatabaseUrls(spec: ApplicationSpec): Set<string> {
  const urls = new Set<string>();
  for (const service of spec.services) {
    const url = service.type === 'database' && service.database ? databaseUrl(service, service.database) : undefined;
    if (url) urls.add(url);
  }
  return urls;
}

/** The app-wide env minus anything that carries database credentials (`DATABASE_URL`, `*_DATABASE_URL`, or a generated connection URL under any name). */
export function withoutDatabaseCredentials(env: Record<string, string>, spec: ApplicationSpec): Record<string, string> {
  const generated = generatedDatabaseUrls(spec);
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => name !== 'DATABASE_URL' && !name.endsWith('_DATABASE_URL') && !generated.has(value)));
}

/** The full environment for `serviceId`. Throws for an id the spec does not have. */
export function serviceEnv(spec: ApplicationSpec, serviceId: string): Record<string, string> {
  const service = spec.services.find((candidate) => candidate.id === serviceId);
  if (!service) throw new Error(`No service "${serviceId}" in this application.`);

  // A role that may not hold credentials does not get them through the app-wide env either; its own `env` is an explicit opt-in.
  const appEnv = CREDENTIAL_POLICY[roleOf(service)].databaseCredentials ? { ...spec.env } : withoutDatabaseCredentials(spec.env ?? {}, spec);
  const env: Record<string, string> = { ...appEnv, ...serviceMap(spec) };
  env.BUILDERFORCE_SERVICE = service.id;
  env.BUILDERFORCE_PROJECT_ID = spec.projectId;
  if (service.port !== undefined) env.PORT = String(service.port);

  if (receivesDatabaseCredentials(service)) {
    const urls: string[] = [];
    for (const dependency of service.dependsOn ?? []) {
      const database = spec.services.find((candidate) => candidate.id === dependency && candidate.type === 'database');
      const url = database?.database ? databaseUrl(database, database.database) : undefined;
      if (!database || !url) continue;
      env[`${envName(database.id)}_DATABASE_URL`] = url;
      urls.push(url);
    }
    // The conventional name, when it is unambiguous.
    if (urls.length === 1) env.DATABASE_URL = urls[0]!;
  }
  return { ...env, ...service.env };
}
