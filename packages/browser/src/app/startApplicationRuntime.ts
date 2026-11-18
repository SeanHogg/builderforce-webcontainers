/**
 * `startApplicationRuntime(spec, options)`: run an application of several
 * services in this runtime. Each service starts once the services it depends on
 * are ready; a failed service applies its own restart policy and leaves the
 * others alone; `stop()` stops dependents before what they depend on.
 *
 * The spec is validated up front (`ApplicationSpecError`). Nothing starts until
 * `start()`.
 */
import {
  createProviderRegistry,
  serviceEnv,
  serviceGraph,
  type ApplicationSpec,
  type ProviderRegistry,
  type StateChange,
} from '@seanhogg/builderforce-webcontainers-core/app';
import { createListeners } from './listeners.js';
import { createServiceLogs } from './serviceLogs.js';
import { ServiceFailure, superviseService, type SupervisedService } from './superviseService.js';
import { ApplicationStartError, type ApplicationRuntime, type ApplicationRuntimeOptions, type ServiceError } from './types.js';

const DEFAULTS = { readinessTimeoutMs: 120_000, stopTimeoutMs: 5_000, stableAfterMs: 10_000 };

const isRegistry = (providers: ApplicationRuntimeOptions['providers']): providers is ProviderRegistry => 'resolve' in providers;

/** Rejects as soon as `signal` aborts, whatever `promise` does. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Cancelled.'));
  return Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled.')), { once: true }))]);
}

function errorOf(reason: unknown, serviceId: string): ServiceError {
  if (reason instanceof ServiceFailure) return reason.error;
  return { serviceId, phase: 'start', message: reason instanceof Error ? reason.message : String(reason), willRestart: false };
}

export function startApplicationRuntime(spec: ApplicationSpec, options: ApplicationRuntimeOptions): ApplicationRuntime {
  const graph = serviceGraph(spec);
  const registry = isRegistry(options.providers) ? options.providers : createProviderRegistry(options.providers);
  const logs = createServiceLogs(options.logHistory);
  const stateChanges = createListeners<StateChange>();
  const errors = createListeners<ServiceError>();
  const services = new Map<string, SupervisedService>();

  const dependenciesReady = (serviceId: string, signal: AbortSignal) =>
    untilAborted(
      Promise.all(
        graph.dependenciesOf(serviceId).map((dependency) =>
          services
            .get(dependency)!
            .whenReady()
            .catch((reason: unknown) => {
              throw new Error(`Dependency "${dependency}" is not available: ${errorOf(reason, dependency).message}`);
            }),
        ),
      ).then(() => undefined),
      signal,
    );

  for (const id of graph.startOrder) {
    services.set(
      id,
      superviseService({
        spec: spec.services.find((service) => service.id === id)!,
        env: serviceEnv(spec, id),
        registry,
        logs,
        onStateChange: (change) => stateChanges.emit(change),
        onError: (error) => errors.emit(error),
        dependenciesReady: (signal) => dependenciesReady(id, signal),
        readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULTS.readinessTimeoutMs,
        stopTimeoutMs: options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs,
        restart: options.restart ?? {},
        stableAfterMs: options.stableAfterMs ?? DEFAULTS.stableAfterMs,
      }),
    );
  }

  const service = (serviceId: string) => {
    const found = services.get(serviceId);
    if (!found) throw new Error(`No service "${serviceId}" in this application.`);
    return found;
  };

  /** Run each start; throw one `ApplicationStartError` for every service that failed for good. */
  const settle = async (starts: Array<[string, Promise<void>]>) => {
    const results = await Promise.allSettled(starts.map(([, start]) => start));
    const failures = results.flatMap((result, index) => (result.status === 'rejected' ? [errorOf(result.reason, starts[index]![0])] : []));
    if (failures.length > 0) throw new ApplicationStartError(failures);
  };

  return {
    projectId: spec.projectId,
    // In start order, so every dependency's readiness exists before its dependents ask for it.
    start: () => settle(graph.startOrder.map((id) => [id, service(id).start()])),
    async stop() {
      for (const id of graph.stopOrder) await service(id).stop();
    },
    async restart(serviceId) {
      const target = service(serviceId);
      await target.stop();
      await settle([[serviceId, target.start()]]);
    },
    getService: (serviceId) => services.get(serviceId)?.snapshot(),
    listServices: () => graph.startOrder.map((id) => service(id).snapshot()),
    getUrl: (serviceId) => services.get(serviceId)?.url(),
    logs: (serviceId) => logs.stream(serviceId),
    onStateChange: (listener) => stateChanges.on(listener),
    onError: (listener) => errors.on(listener),
  };
}
