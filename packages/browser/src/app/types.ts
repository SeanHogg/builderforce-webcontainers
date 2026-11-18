/**
 * The public shape of a running application (`startApplicationRuntime`): what a
 * host calls, and what it hears back.
 */
import type {
  ApplicationSpec,
  DatabaseControl,
  ProviderRegistry,
  RestartLimits,
  RuntimeProvider,
  ServiceRole,
  ServiceState,
  ServiceType,
  StateChange,
} from '@seanhogg/builderforce-webcontainers-core/app';

/** One line of a service's output, or a line the runtime wrote about it (`source: 'runtime'`). */
export interface ServiceLogEntry {
  serviceId: string;
  source: 'output' | 'runtime';
  /** Without the trailing newline. */
  text: string;
  /** `Date.now()` when it arrived. */
  at: number;
}

/**
 * Where a service failed. `declined` and `dependency` never restart; `start`,
 * `readiness` and `exit` follow the restart policy. `stopped` is not a failure:
 * the service was stopped (by `stop()`, or a stop racing a `restart()`) before
 * it was ready. It is never reported through `onError`, and `start()` does not
 * count it as a failure.
 */
export type ServiceErrorPhase = 'declined' | 'dependency' | 'start' | 'readiness' | 'exit' | 'stopped';

export interface ServiceError {
  serviceId: string;
  phase: ServiceErrorPhase;
  message: string;
  /** Set when the process had exited. */
  exitCode?: number;
  /** Whether the runtime will start the service again on its own. */
  willRestart: boolean;
}

/** A service as the host sees it right now. */
export interface ServiceSnapshot {
  id: string;
  type: ServiceType;
  runtime: string;
  role: ServiceRole;
  state: ServiceState;
  port?: number;
  /** Where a browser reaches it (the preview URL for its port), once it listens. */
  url?: string;
  /** Restarts in a row since it last started by request (`start`/`restart`). */
  restarts: number;
  /** The last exit code, once a process has exited. */
  exitCode?: number;
  /** The last error, until the service is ready again. */
  error?: ServiceError;
}

/**
 * The runtime's processes, attributed to the application identities this
 * runtime mints (`ProcessHost.killApplication`): what ends an application's (or
 * one service's) whole set — `detached` children included — when it stops.
 */
export interface AttributedProcesses {
  killApplication(applicationId: string, serviceId?: string): void;
}

/** Where an application's service graph is put in force; returns the unregister. */
export interface ApplicationPortPolicy {
  register(applicationId: string, spec: ApplicationSpec): () => void;
}

/**
 * The runtime an application runs on, as the application runtime needs it: a
 * `PreviewRuntime` (`startPreviewRuntime()`) or a `ProcessHost` IS one.
 */
export interface ApplicationHost extends AttributedProcesses {
  /** The runtime's port policy: the application's `dependsOn` graph is put in force here while it runs (W10 control 4). */
  readonly portPolicy: ApplicationPortPolicy;
  /** The application was disposed: drop what the runtime keeps for it (its `pip install` record, training state). */
  forgetApplication?(applicationId: string): void;
}

export interface ApplicationRuntimeOptions {
  /** The runtimes services run on (`createNodeProvider(runtime)`), or a registry of them. */
  providers: readonly RuntimeProvider[] | ProviderRegistry;
  /**
   * The runtime the providers spawn on (`startPreviewRuntime()`'s). Required:
   * its port policy gets the application's `dependsOn` graph on `start()` (and
   * loses it on `stop()` / `dispose()`) — without it no service could reach
   * another — and its attributed processes are ended when a service or the
   * application stops.
   */
  runtime: ApplicationHost;
  /** Override `runtime` as the processes ended on stop. */
  processes?: AttributedProcesses;
  /** Override `runtime.portPolicy`. */
  portPolicy?: ApplicationPortPolicy;
  /** Default readiness timeout, when a service's readiness sets none. Default 120000ms. */
  readinessTimeoutMs?: number;
  /** How long a stopping service gets after `SIGTERM` before `SIGKILL`. Default 5000ms. */
  stopTimeoutMs?: number;
  /** Restart limits and backoff for the restart policy. */
  restart?: RestartLimits;
  /** A service that stayed ready this long has its restart count reset when it exits. Default 10000ms. */
  stableAfterMs?: number;
  /** How long a service waits for its dependencies to be ready before it fails (phase `dependency`). Default 600000ms. */
  dependencyTimeoutMs?: number;
  /** Lines of log history kept for late `logs()` readers. Default 5000. */
  logHistory?: number;
  /** Entries a `logs()` reader may fall behind by; past it, entries are dropped and a `runtime` line says how many. Default 1000. */
  logReaderBuffer?: number;
}

export interface ApplicationRuntime {
  readonly projectId: string;
  /** This application's identity, minted when it was created: every service's processes carry it (`SecurityContext.applicationId`). */
  readonly applicationId: string;
  /**
   * Start every service: each one after the services it depends on are ready.
   * First, every service must be accepted by a provider: if any is declined,
   * nothing starts and this rejects with `ApplicationStartError` (phase
   * `declined`) — never a half-started application. Otherwise resolves when all
   * are ready (or were stopped meanwhile); rejects with `ApplicationStartError`
   * naming the services that failed for good — the others keep running.
   */
  start(): Promise<void>;
  /** Stop every service, dependents first: `SIGTERM`, then `SIGKILL` after the stop timeout. `logs()` streams stay open (a later `start()` continues them). */
  stop(): Promise<void>;
  /**
   * Stop and start one service. Other services, dependents included, keep
   * running; a dependent still waiting for it keeps waiting. Resolves when it is
   * ready again. Its dependencies must be up: restarting a service whose
   * dependency is not running fails it (phase `dependency`) at once.
   */
  restart(serviceId: string): Promise<void>;
  /** `stop()`, then close every `logs()` stream (so `for await` loops end). The runtime cannot start again. */
  dispose(): Promise<void>;
  getService(serviceId: string): ServiceSnapshot | undefined;
  /** Every service, in start order. */
  listServices(): ServiceSnapshot[];
  /** Where a browser reaches the service (its preview URL), once it listens. */
  getUrl(serviceId: string): string | undefined;
  /**
   * Output, live, after the history kept so far: one service's, or every
   * service's merged. A reader that falls `logReaderBuffer` entries behind loses
   * the overflow (a `runtime` entry counts it). Open until `dispose()`; cancel
   * the stream to stop reading sooner.
   */
  logs(serviceId?: string): ReadableStream<ServiceLogEntry>;
  onStateChange(listener: (change: StateChange) => void): () => void;
  onError(listener: (error: ServiceError) => void): () => void;
  /**
   * A database service's data: `export()` a snapshot, `import(blob)` one in its
   * place, `reset()` to empty. Each call reaches the database running at that
   * moment and rejects when it is not running. Throws for an id that is not a
   * database service.
   */
  database(serviceId: string): DatabaseControl;
}

/** `start()` or `restart()` could not bring every service up. */
export class ApplicationStartError extends Error {
  constructor(readonly failures: ServiceError[]) {
    super(`Services failed to start: ${failures.map((failure) => `${failure.serviceId} (${failure.message})`).join('; ')}`);
    this.name = 'ApplicationStartError';
  }
}
