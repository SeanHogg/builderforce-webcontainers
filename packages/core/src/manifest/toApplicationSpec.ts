/**
 * `toApplicationSpec`: one environment of a manifest as the `ApplicationSpec`
 * the application runtime runs. Pure. The environment's overrides apply first,
 * then its tier variables (below each service's own `env`). Each resource the
 * target hosts as a process becomes a service (Postgres → a `database` service
 * on the capability's provider, e.g. PGlite); a resource the target cannot host
 * is a typed decline with the capability's reason, and the app still runs
 * without it. Jobs the target cannot run yet are a warning, not a decline.
 * The produced spec goes through `validateSpec`, whose issues pass through.
 */
import type { ReadinessSpec, ServiceSpec, ApplicationSpec } from '../app/spec.js';
import { validateSpec } from '../app/validateSpec.js';
import { JOB_CAPABILITIES, resourceCapability } from './capabilities.js';
import { parseDuration } from './duration.js';
import { dedupeIssues, hasErrors, manifestIssue, type ManifestIssue } from './issues.js';
import { isRecord, resolveEnvironment } from './overrides.js';
import { isCommandLineWarning, jobCommandIssues, serviceCommand } from './serviceCommand.js';
import { tierEnv } from './tierEnv.js';
import type { AppManifest, ManifestReadiness, ManifestService, ResolvedEnvironment, ResourceSpec } from './types.js';
import { validateManifest } from './validate.js';

export interface DeclinedResource {
  /** The resource id. */
  id: string;
  /** Why the target does not host it, from the capability matrix. */
  reason: string;
}

export interface ToApplicationSpecOptions {
  projectId: string;
}

export interface ManifestSpecResult {
  /** Null when any issue is an error. */
  spec: ApplicationSpec | null;
  /** The resolved environment (null for an unknown one). */
  environment: ResolvedEnvironment | null;
  declined: DeclinedResource[];
  issues: ManifestIssue[];
}

/** The port a generated database service listens on by default. */
const DATABASE_PORTS: Readonly<Partial<Record<ResourceSpec['type'], number>>> = { postgres: 5432 };

/** Resources the HOST delivers (vault, AI gateway) — never a process, never a "provisioned by its deployment" decline. */
const HOST_DELIVERED: ReadonlySet<ResourceSpec['type']> = new Set(['connection', 'ai']);

/** `ApplicationSpec` readiness for a manifest readiness. */
export function toReadinessSpec(readiness: ManifestReadiness): ReadinessSpec | undefined {
  const timeoutMs = readiness.timeout === undefined ? undefined : parseDuration(readiness.timeout);
  const timeout = timeoutMs === undefined ? {} : { timeoutMs };
  if ('http' in readiness) return { kind: 'http', path: readiness.http, ...timeout };
  if ('port' in readiness) return { kind: 'port', ...timeout };
  if ('query' in readiness) return { kind: 'query', ...timeout };
  if ('exitZero' in readiness) return { kind: 'exit-zero', ...timeout };
  if ('started' in readiness) return { kind: 'started', ...timeout };
  return undefined;
}

function freePort(preferred: number, taken: Set<number>): number {
  let port = preferred;
  while (taken.has(port)) port++;
  taken.add(port);
  return port;
}

function applicationService(id: string, service: ManifestService, environment: ResolvedEnvironment, databaseIds: ReadonlySet<string>, resources: Record<string, ResourceSpec>, issues: ManifestIssue[]): ServiceSpec {
  const usedDatabases = (service.uses ?? []).filter((use) => databaseIds.has(use));
  const dependsOn = [...new Set([...(service.dependsOn ?? []), ...usedDatabases])];
  // Host-delivered uses (`ai`, `connection`) ride on `resourceUses` — the browser seam `serviceEnv` and the port policy read.
  const resourceUses = (service.uses ?? []).flatMap((use) => {
    const resource = resources[use];
    if (!resource || !HOST_DELIVERED.has(resource.type)) return [];
    const entry: { id: string; type: 'ai' | 'connection'; models?: readonly string[] } = { id: use, type: resource.type as 'ai' | 'connection' };
    if (resource.type === 'ai' && resource.models) entry.models = [...resource.models];
    return [entry];
  });
  const readiness = service.readiness ? toReadinessSpec(service.readiness) : service.port === undefined && service.restart === 'always' ? ({ kind: 'started' } as const) : undefined;
  const spec: ServiceSpec = {
    id,
    type: 'application',
    runtime: service.runtime,
    env: { ...tierEnv(service.runtime, environment), ...service.env },
  };
  if (service.role) spec.role = service.role;
  if (service.root) spec.root = service.root;
  if (service.command) Object.assign(spec, serviceCommand(id, service, environment.target, issues));
  else if (service.args) spec.args = [...service.args];
  if (service.port !== undefined) spec.port = service.port;
  if (dependsOn.length > 0) spec.dependsOn = dependsOn;
  if (readiness) spec.readiness = readiness;
  if (service.restart) spec.restartPolicy = service.restart;
  if (resourceUses.length > 0) spec.resourceUses = resourceUses;
  return spec;
}

function databaseService(id: string, resource: ResourceSpec & { type: 'postgres' }, provider: string, port: number): ServiceSpec {
  return {
    id,
    type: 'database',
    runtime: provider,
    port,
    database: { engine: 'postgres', provider, persistent: resource.persistent ?? false, ...(resource.name ? { name: resource.name } : {}) },
  };
}

function specIssue(issue: ReturnType<typeof validateSpec>[number]): ManifestIssue {
  if (issue.code.startsWith('ingress-')) return manifestIssue('spec', 'ingress', { spec: issue });
  const serviceId = 'serviceId' in issue ? issue.serviceId : undefined;
  return manifestIssue('spec', serviceId ? `services.${serviceId}` : 'services', { spec: issue });
}

/** `envName`'s environment of `manifest` as an `ApplicationSpec`, with what was declined and every issue. */
export function toApplicationSpec(manifest: AppManifest, envName: string, options: ToApplicationSpecOptions): ManifestSpecResult {
  const resolution = resolveEnvironment(manifest, envName);
  // Command-line warnings are read again below from the effective commands: the base manifest's may name a command an override replaced.
  const issues = [...validateManifest(manifest).filter((issue) => !isCommandLineWarning(issue)), ...resolution.issues];
  const resolved = resolution.manifest;
  const environment = resolution.environment;
  // A manifest too broken to read further (sections of the wrong shape) is reported, not mapped.
  if (!resolved || !environment || hasErrors(issues)) return { spec: null, environment, declined: [], issues: dedupeIssues(issues) };

  const resources = resolved.resources ?? {};
  const services = resolved.services ?? {};
  const declined: DeclinedResource[] = [];
  const specServices: ServiceSpec[] = [];
  const databaseIds = new Set<string>();
  const takenPorts = new Set(Object.values(services).flatMap((service) => (service.port === undefined ? [] : [service.port])));

  for (const [id, resource] of Object.entries(resources)) {
    const capability = resourceCapability(resource.type, environment.target);
    if (!capability.supported) {
      declined.push({ id, reason: capability.reason ?? `The ${environment.target} target does not host "${resource.type}" resources.` });
      continue;
    }
    const defaultPort = DATABASE_PORTS[resource.type];
    if (resource.type === 'postgres' && defaultPort !== undefined && capability.provider) {
      specServices.push(databaseService(id, resource, capability.provider, freePort(defaultPort, takenPorts)));
      databaseIds.add(id);
    } else if (!HOST_DELIVERED.has(resource.type)) {
      // Host-delivered resources (vault connections, the AI gateway) reach services through the host; anything else hosted is the deployment's to provision.
      declined.push({ id, reason: `"${resource.type}" resources on ${environment.target} are provisioned by its deployment, not run by the application runtime.` });
    }
  }

  for (const [id, service] of Object.entries(services)) specServices.push(applicationService(id, service, environment, databaseIds, resources, issues));

  const jobs = isRecord(resolved.jobs) ? Object.keys(resolved.jobs) : [];
  for (const [id, job] of Object.entries(resolved.jobs ?? {})) issues.push(...jobCommandIssues(id, job, services, environment.target));
  const jobCapability = JOB_CAPABILITIES[environment.target];
  if (!jobCapability.supported) {
    for (const id of jobs) issues.push(manifestIssue('jobs-not-run', `jobs.${id}`, { severity: 'warning', detail: jobCapability.reason }));
  }

  const spec: ApplicationSpec = { projectId: options.projectId, services: specServices };
  const routes = resolved.ingress?.routes ?? [];
  if (routes.length > 0) spec.ingress = { routes: routes.map((route) => ({ path: route.path, serviceId: route.service })) };
  issues.push(...validateSpec(spec).map(specIssue));
  const all = dedupeIssues(issues);
  return { spec: hasErrors(all) ? null : spec, environment, declined, issues: all };
}
