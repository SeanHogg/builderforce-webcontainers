/**
 * `startApplicationRuntime(spec, options)`: run an application of several
 * services in this runtime. Each service starts once the services it depends on
 * are ready; a failed service applies its own restart policy and leaves the
 * others alone; `stop()` stops dependents before what they depend on.
 *
 * The spec is validated up front (`ApplicationSpecError`). Nothing starts until
 * `start()`, and `start()` starts nothing unless every service is accepted.
 */
import {
  acceptApplication,
  createProviderRegistry,
  serviceEnv,
  serviceGraph,
  type ApplicationSpec,
  type ProviderRegistry,
  type ServiceSpec,
  type StateChange,
} from '@seanhogg/builderforce-webcontainers-core/app';
import { hashAlgorithm } from '@seanhogg/builderforce-webcontainers-core';
import { messageOf } from './asyncHelpers.js';
import { ServiceFailure } from './awaitReadiness.js';
import { createListeners } from './listeners.js';
import { createServiceLogs } from './serviceLogs.js';
import { superviseService, type SupervisedService } from './superviseService.js';
import { ApplicationStartError, type ApplicationRuntime, type ApplicationRuntimeOptions, type ServiceError } from './types.js';

const DEFAULTS = { readinessTimeoutMs: 120_000, dependencyTimeoutMs: 600_000, stopTimeoutMs: 5_000, stableAfterMs: 10_000 };

const isRegistry = (providers: ApplicationRuntimeOptions['providers']): providers is ProviderRegistry => 'resolve' in providers;

/** Wait for each start; throw one `ApplicationStartError` for the services that failed (a service stopped meanwhile did not fail). */
async function settle(starts: Array<[string, Promise<void>]>): Promise<void> {
  const results = await Promise.allSettled(starts.map(([, start]) => start));
  const failures = results.flatMap((result, index): ServiceError[] => {
    if (result.status === 'fulfilled') return [];
    const error: ServiceError =
      result.reason instanceof ServiceFailure ? result.reason.error : { serviceId: starts[index]![0], phase: 'start', message: messageOf(result.reason), willRestart: false };
    return error.phase === 'stopped' ? [] : [error];
  });
  if (failures.length > 0) throw new ApplicationStartError(failures);
}

/**
 * The application's STABLE identity, derived here from the project and the
 * application's services (their ids and directories) — the same on every start,
 * so its preview origin (keyed on it) and that origin's storage are too; two
 * applications in one project live in different service directories, so they
 * never share one. Never `workspace` or `platform`.
 */
function mintApplicationId(spec: ApplicationSpec): string {
  const services = spec.services.map((service) => `${service.id}\u0000${service.root ?? '/'}`).sort().join('\u0001');
  const digest = hashAlgorithm('sha256').digest(new TextEncoder().encode(services));
  return `app:${spec.projectId}:${Array.from(digest.subarray(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function startApplicationRuntime(spec: ApplicationSpec, options: ApplicationRuntimeOptions): ApplicationRuntime {
  const graph = serviceGraph(spec);
  const registry = isRegistry(options.providers) ? options.providers : createProviderRegistry(options.providers);
  const logs = createServiceLogs({ history: options.logHistory, readerBuffer: options.logReaderBuffer });
  const stateChanges = createListeners<StateChange>();
  const errors = createListeners<ServiceError>();
  const services = new Map<string, SupervisedService>();
  let disposed = false;
  // Derived here, never a value the spec sets: every service's processes carry it (W10 principle 3).
  const applicationId = mintApplicationId(spec);
  /** A client's login for a database: generated and held by the database's provider (W10 control 5). */
  const databaseCredentials = (database: ServiceSpec, client: ServiceSpec) => {
    const resolution = registry.resolve(database);
    return resolution.ok ? resolution.provider.databaseCredentials?.(database, client) : undefined;
  };

  // The runtime the application runs on: ends its attributed processes, holds its port graph.
  const processes = options.processes ?? options.runtime;
  const portPolicy = options.portPolicy ?? options.runtime.portPolicy;

  for (const id of graph.startOrder) {
    // Start order: every dependency is created before its dependents.
    const dependencies = graph.dependenciesOf(id).map((dependency) => services.get(dependency)!);
    services.set(
      id,
      superviseService({
        spec: spec.services.find((service) => service.id === id)!,
        env: serviceEnv(spec, id, { databaseCredentials }),
        registry,
        logs,
        onStateChange: (change) => stateChanges.emit(change),
        onError: (error) => errors.emit(error),
        dependencies: () => dependencies,
        readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULTS.readinessTimeoutMs,
        dependencyTimeoutMs: options.dependencyTimeoutMs ?? DEFAULTS.dependencyTimeoutMs,
        stopTimeoutMs: options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs,
        restart: options.restart ?? {},
        stableAfterMs: options.stableAfterMs ?? DEFAULTS.stableAfterMs,
        security: Object.freeze({ applicationId, serviceId: id }),
        processes,
      }),
    );
  }

  const service = (serviceId: string) => {
    const found = services.get(serviceId);
    if (!found) throw new Error(`No service "${serviceId}" in this application.`);
    return found;
  };
  const assertLive = () => {
    if (disposed) throw new Error('This application runtime was disposed.');
  };
  /** The service graph in force on the runtime's ports while the application runs (W10 control 4). */
  let unregisterGraph: (() => void) | undefined;
  const stopAll = async () => {
    for (const id of graph.stopOrder) await service(id).stop();
    processes.killApplication(applicationId); // whatever outlived its service: the whole attributed set
    unregisterGraph?.();
    unregisterGraph = undefined;
  };

  return {
    projectId: spec.projectId,
    applicationId,
    async start() {
      assertLive();
      // All or nothing: a declined service means another target, never a half-started app.
      const acceptance = acceptApplication(spec.services, registry);
      if (!acceptance.ok) {
        const failures = acceptance.declined.map(({ serviceId, reason }): ServiceError => ({ serviceId, phase: 'declined', message: reason, willRestart: false }));
        failures.forEach((failure) => errors.emit(failure));
        throw new ApplicationStartError(failures);
      }
      // Before any service runs: its dials are decided against this graph.
      unregisterGraph ??= portPolicy.register(applicationId, spec);
      // In start order, so each service exists and is on its way before its dependents look at it.
      await settle(graph.startOrder.map((id) => [id, service(id).start()]));
    },
    stop: stopAll,
    async restart(serviceId) {
      assertLive();
      const target = service(serviceId);
      await settle([[serviceId, target.restart()]]);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await stopAll();
      logs.close();
    },
    getService: (serviceId) => services.get(serviceId)?.snapshot(),
    listServices: () => graph.startOrder.map((id) => service(id).snapshot()),
    getUrl: (serviceId) => services.get(serviceId)?.url(),
    logs: (serviceId) => logs.stream(serviceId),
    onStateChange: (listener) => stateChanges.on(listener),
    onError: (listener) => errors.on(listener),
    database(serviceId) {
      const target = service(serviceId);
      if (spec.services.find((candidate) => candidate.id === serviceId)?.type !== 'database') throw new Error(`Service "${serviceId}" is not a database.`);
      const running = async () => target.database() ?? Promise.reject(new Error(`Database "${serviceId}" is not running.`));
      return {
        export: async () => (await running()).export(),
        import: async (data) => (await running()).import(data),
        reset: async () => (await running()).reset(),
      };
    },
  };
}
