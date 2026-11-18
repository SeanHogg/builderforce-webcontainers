/**
 * The public shape of a running application (`startApplicationRuntime`): what a
 * host calls, and what it hears back.
 */
import type {
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

/** Where a service failed. `declined` and `dependency` never restart; the rest follow the restart policy. */
export type ServiceErrorPhase = 'declined' | 'dependency' | 'start' | 'readiness' | 'exit';

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

export interface ApplicationRuntimeOptions {
  /** The runtimes services run on (`createNodeProvider(runtime)`), or a registry of them. */
  providers: readonly RuntimeProvider[] | ProviderRegistry;
  /** Default readiness timeout, when a service's readiness sets none. Default 120000ms. */
  readinessTimeoutMs?: number;
  /** How long a stopping service gets after `SIGTERM` before `SIGKILL`. Default 5000ms. */
  stopTimeoutMs?: number;
  /** Restart limits and backoff for the restart policy. */
  restart?: RestartLimits;
  /** A service that stayed ready this long has its restart count reset when it exits. Default 10000ms. */
  stableAfterMs?: number;
  /** Lines of log history kept for late `logs()` readers. Default 5000. */
  logHistory?: number;
}

export interface ApplicationRuntime {
  readonly projectId: string;
  /**
   * Start every service: each one after the services it depends on are ready.
   * Resolves when all are ready; rejects with `ApplicationStartError` naming the
   * services that failed for good — the others keep running.
   */
  start(): Promise<void>;
  /** Stop every service, dependents first: `SIGTERM`, then `SIGKILL` after the stop timeout. */
  stop(): Promise<void>;
  /** Stop and start one service. Other services, dependents included, keep running. Resolves when it is ready again. */
  restart(serviceId: string): Promise<void>;
  getService(serviceId: string): ServiceSnapshot | undefined;
  /** Every service, in start order. */
  listServices(): ServiceSnapshot[];
  /** Where a browser reaches the service (its preview URL), once it listens. */
  getUrl(serviceId: string): string | undefined;
  /** Output, live, after the history kept so far: one service's, or every service's merged. Cancel the stream to stop reading. */
  logs(serviceId?: string): ReadableStream<ServiceLogEntry>;
  onStateChange(listener: (change: StateChange) => void): () => void;
  onError(listener: (error: ServiceError) => void): () => void;
}

/** `start()` or `restart()` could not bring every service up. */
export class ApplicationStartError extends Error {
  constructor(readonly failures: ServiceError[]) {
    super(`Services failed to start: ${failures.map((failure) => `${failure.serviceId} (${failure.message})`).join('; ')}`);
    this.name = 'ApplicationStartError';
  }
}
