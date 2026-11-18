/**
 * `ApplicationSpec`: the plain input that describes an application of several
 * services — what to run, where, on which port, after which other services, how
 * to tell it is ready, and what to do when it exits. A host (Builderforce maps
 * its `AppBlueprint` here; a standalone user writes it by hand) passes one to
 * the browser package's `startApplicationRuntime`. Pure data: no browser APIs.
 */

/** What a service is. Each kind is started by a runtime provider that accepts it. */
export type ServiceType = 'application' | 'database' | 'training';

/**
 * Where an application service's code runs. A `frontend` ships code to the
 * browser, so it never receives database credentials (see `serviceEnv`).
 */
export type ServiceRole = 'frontend' | 'backend';

/** When a service counts as ready, so services that depend on it may start. */
export type ReadinessSpec =
  /** The service's port opens. */
  | { kind: 'port'; timeoutMs?: number }
  /** `GET http://localhost:<port><path>` answers 2xx or 3xx. */
  | { kind: 'http'; path: string; timeoutMs?: number }
  /** The database accepts a query. */
  | { kind: 'query'; timeoutMs?: number }
  /** The process exits with code 0 (a migration, a seed, a one-off build). */
  | { kind: 'exit-zero'; timeoutMs?: number };

export type ReadinessKind = ReadinessSpec['kind'];

/** What happens when a service's process exits on its own. */
export type RestartPolicy = 'never' | 'on-failure' | 'always';

export interface DatabaseSpec {
  /** e.g. `postgres`. */
  engine: string;
  /** Who hosts it, e.g. `pglite` in the browser. */
  provider: string;
  /** Data outlives the application (kept outside the project files). */
  persistent: boolean;
  /** Database name. Default: the service id. */
  name?: string;
  /** Default `postgres`. */
  user?: string;
  /** Default `postgres`. */
  password?: string;
}

export interface ServiceSpec {
  /** Unique within the application: `web`, `api`, `db`. */
  id: string;
  type: ServiceType;
  /** The runtime provider that starts it, by id: `node`. */
  runtime: string;
  /** Default `backend`. Only meaningful for `application` services. */
  role?: ServiceRole;
  /** The service's directory, project-relative (`/` is the project, `/apps/api` a folder in it). Default `/`. */
  root?: string;
  /** `node`, `npm`, … */
  command?: string;
  args?: string[];
  /** Extra environment; wins over everything the runtime injects. */
  env?: Record<string, string>;
  /** The port the service listens on (also its `PORT` env). */
  port?: number;
  /** Services that must be ready before this one starts. */
  dependsOn?: string[];
  /** Default `{ kind: 'port' }` when the service has a port, else `{ kind: 'exit-zero' }`. */
  readiness?: ReadinessSpec;
  /** Default `on-failure`. */
  restartPolicy?: RestartPolicy;
  /** Required for `database` services. */
  database?: DatabaseSpec;
}

export interface ApplicationSpec {
  /** Stable project id; services see it as `BUILDERFORCE_PROJECT_ID`. */
  projectId: string;
  services: ServiceSpec[];
  /** Environment for every service (below each service's own `env`). */
  env?: Record<string, string>;
}

/** The readiness a service is held to, defaults applied. */
export function readinessOf(service: ServiceSpec): ReadinessSpec {
  return service.readiness ?? (service.port === undefined ? { kind: 'exit-zero' } : { kind: 'port' });
}

/** The restart policy a service is held to, defaults applied. */
export function restartPolicyOf(service: ServiceSpec): RestartPolicy {
  return service.restartPolicy ?? 'on-failure';
}

/** The role a service is held to, defaults applied. */
export function roleOf(service: ServiceSpec): ServiceRole {
  return service.role ?? 'backend';
}
