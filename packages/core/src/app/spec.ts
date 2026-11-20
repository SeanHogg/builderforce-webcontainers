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
  | { kind: 'exit-zero'; timeoutMs?: number }
  /** The process started (a long-running job with no port: a `training` service). */
  | { kind: 'started'; timeoutMs?: number };

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
  /** Default `{ kind: 'started' }` for a `training` service, else `{ kind: 'port' }` when it has a port, else `{ kind: 'exit-zero' }`. */
  readiness?: ReadinessSpec;
  /** Default `never` for a `training` service, else `on-failure`. */
  restartPolicy?: RestartPolicy;
  /** Required for `database` services. */
  database?: DatabaseSpec;
}

/** One ingress route: requests whose path starts with `path` go to `serviceId`'s port. */
export interface ApplicationIngressRoute {
  /** A path prefix starting with `/`, matched on whole segments (`/api` takes `/api` and `/api/x`, never `/apix`); `/` is the catch-all. */
  path: string;
  /** The service whose port serves it; it must declare a `port`. */
  serviceId: string;
}

/**
 * How requests to the application's own origin reach its services (the
 * manifest's `ingress`): the longest matching route wins. In the browser the
 * preview service worker applies it, so a frontend's relative `fetch('/api/…')`
 * reaches the backend's port — under the same port policy as any other dial.
 */
export interface ApplicationIngress {
  routes: ApplicationIngressRoute[];
}

export interface ApplicationSpec {
  /** Stable project id; services see it as `BUILDERFORCE_PROJECT_ID`. */
  projectId: string;
  services: ServiceSpec[];
  /** Environment for every service (below each service's own `env`). */
  env?: Record<string, string>;
  /** Path-prefix routing to services' ports (see {@link ApplicationIngress}). */
  ingress?: ApplicationIngress;
}

/** The readiness a service is held to, defaults applied. */
export function readinessOf(service: ServiceSpec): ReadinessSpec {
  if (service.readiness) return service.readiness;
  if (service.type === 'training') return { kind: 'started' };
  return service.port === undefined ? { kind: 'exit-zero' } : { kind: 'port' };
}

/** The restart policy a service is held to, defaults applied (`never` for a `training` service). */
export function restartPolicyOf(service: ServiceSpec): RestartPolicy {
  return service.restartPolicy ?? (service.type === 'training' ? 'never' : 'on-failure');
}

/** The role a service is held to, defaults applied. */
export function roleOf(service: ServiceSpec): ServiceRole {
  return service.role ?? 'backend';
}

/** An ingress path as routes compare it: no trailing `/` (except the catch-all `/`). */
export function ingressPathKey(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** One ingress route resolved to its service's port. */
export interface IngressPortRoute {
  path: string;
  serviceId: string;
  port: number;
}

/**
 * The application's ingress as the runtime applies it: each route with its
 * service's port, longest path first (so the first match is the longest). Routes
 * naming an unknown service or one without a port are dropped (`validateSpec`
 * reports them). `frontend`: who a request through the ingress acts as when the
 * page that made it cannot be told — the catch-all route's service, else the one
 * `frontend` service; undefined when neither picks one.
 */
export function ingressTable(spec: ApplicationSpec): { routes: IngressPortRoute[]; frontend?: string } {
  const ports = new Map(spec.services.flatMap((service) => (service.port === undefined ? [] : [[service.id, service.port] as const])));
  const routes = (spec.ingress?.routes ?? [])
    .flatMap((route) => (ports.has(route.serviceId) && route.path?.startsWith('/') ? [{ path: ingressPathKey(route.path), serviceId: route.serviceId, port: ports.get(route.serviceId)! }] : []))
    .sort((a, b) => b.path.length - a.path.length);
  const frontends = spec.services.filter((service) => service.type === 'application' && service.role === 'frontend');
  const frontend = routes.find((route) => route.path === '/')?.serviceId ?? (frontends.length === 1 ? frontends[0]!.id : undefined);
  return frontend === undefined ? { routes } : { routes, frontend };
}
