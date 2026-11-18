/**
 * The port every runtime (Node today; databases, Python, … later) implements,
 * and the registry that picks one per service by its `runtime` id. Adding a
 * runtime is one registry entry, never a branch in the orchestrator. A service
 * no provider accepts is declined with a reason, so a host can send the whole
 * application to another target instead of half-running it.
 */
import type { SecurityContext } from '../system/securityContext.js';
import type { ServiceSpec } from './spec.js';
import type { DatabaseCredential } from './serviceEnv.js';

export type Acceptance = { ok: true } | { ok: false; reason: string };

export interface ServiceStartContext {
  /** The service's environment (`serviceEnv`). */
  env: Record<string, string>;
  /** Aborted when the application stops this service before it is ready. */
  signal: AbortSignal;
  /**
   * Who the service's processes are: `(applicationId, serviceId)`, minted by
   * the application runtime — never read from the spec, its env or the app.
   * A provider spawns with it (and probes readiness with it), so every
   * page-side decision about the service's processes, ports and files is
   * taken against it.
   */
  readonly security: SecurityContext;
}

/** A started service, as the orchestrator drives it. */
export interface ServiceHandle {
  /** The service's output (stdout and stderr interleaved). Read once, by the orchestrator. */
  readonly output: ReadableStream<string>;
  /**
   * Resolves when the service meets its readiness; rejects with the reason it
   * cannot (it exited first, the probe failed). The orchestrator applies the timeout.
   */
  ready(): Promise<void>;
  /** Resolves with the exit code (128 + signal number when killed). */
  wait(): Promise<number>;
  /** Default `SIGTERM`; `SIGKILL` cannot be caught. */
  kill(signal?: string): void;
  /**
   * Ask the service to save its progress and exit (a `training` service). A
   * stop calls it before `SIGTERM`, waiting up to the stop timeout for the exit.
   */
  checkpoint?(): Promise<void>;
  /** Where a browser reaches the service, once it is listening. */
  url(): string | undefined;
  /** A database service's data operations (`ApplicationRuntime.database(id)`). */
  readonly database?: DatabaseControl;
}

/**
 * A running database's data, as a host manages it: `export()` a snapshot
 * (Postgres data-directory tarball), `import()` one in its place, `reset()` to
 * empty. Import and reset close the database's open client connections.
 */
export interface DatabaseControl {
  export(): Promise<Blob>;
  import(data: Blob): Promise<void>;
  reset(): Promise<void>;
}

export interface RuntimeProvider {
  /** Matches `ServiceSpec.runtime`: `node`. */
  readonly id: string;
  /** Whether this provider can run the service, and why not. */
  accepts(service: ServiceSpec): Acceptance;
  start(service: ServiceSpec, context: ServiceStartContext): ServiceHandle | Promise<ServiceHandle>;
  /**
   * For a database this provider runs: the credentials `client` connects with
   * (generated and held by the provider, on the page side), or undefined when
   * `client` may not connect. `serviceEnv` puts them in the client's URL.
   */
  databaseCredentials?(database: ServiceSpec, client: ServiceSpec): DatabaseCredential | undefined;
}

export type ProviderResolution = { ok: true; provider: RuntimeProvider } | { ok: false; reason: string };

export interface ProviderRegistry {
  /** The provider that runs this service, or why none does. */
  resolve(service: ServiceSpec): ProviderResolution;
  readonly providers: readonly RuntimeProvider[];
}

/** Providers by id; a later provider with the same id replaces an earlier one. */
export function createProviderRegistry(providers: readonly RuntimeProvider[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    providers: [...byId.values()],
    resolve(service) {
      const provider = byId.get(service.runtime);
      if (!provider) {
        const available = [...byId.keys()].join(', ') || 'none';
        return { ok: false, reason: `No runtime provider for "${service.runtime}" (available: ${available}).` };
      }
      const acceptance = provider.accepts(service);
      return acceptance.ok ? { ok: true, provider } : { ok: false, reason: acceptance.reason };
    },
  };
}

export interface DeclinedService {
  serviceId: string;
  reason: string;
}

/** Whether every service has a provider that accepts it; otherwise each one declined, with its reason. */
export function acceptApplication(services: readonly ServiceSpec[], registry: ProviderRegistry): { ok: true } | { ok: false; declined: DeclinedService[] } {
  const declined: DeclinedService[] = [];
  for (const service of services) {
    const resolution = registry.resolve(service);
    if (!resolution.ok) declined.push({ serviceId: service.id, reason: resolution.reason });
  }
  return declined.length === 0 ? { ok: true } : { ok: false, declined };
}
