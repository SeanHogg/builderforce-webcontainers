/**
 * Run ONE service through its lifecycle: wait for its dependencies (following
 * their readiness as it changes), start it on the provider that accepts it,
 * hold it to its readiness, and when its process exits on its own apply its
 * restart policy. A failure here touches only this service; dependents that are
 * already running keep running. Stopping is `stopService.ts`; restarts wait in
 * `restartScheduler.ts`.
 */
import {
  ACTIVE_STATES,
  createLifecycle,
  readinessOf,
  restartDecision,
  restartPolicyOf,
  roleOf,
  type ProviderRegistry,
  type RestartDecision,
  type RestartLimits,
  type ServiceHandle,
  type ServiceSpec,
  type StateChange,
} from '@seanhogg/builderforce-webcontainers-core/app';
import { messageOf, within } from './asyncHelpers.js';
import { ServiceFailure, untilReady, type ReadinessSource } from './awaitReadiness.js';
import { createListeners } from './listeners.js';
import { createRestartScheduler } from './restartScheduler.js';
import { abandonProcess, exitWithin, stopRun, type ServiceRun } from './stopService.js';
import type { ServiceLogs } from './serviceLogs.js';
import type { ServiceError, ServiceErrorPhase, ServiceSnapshot } from './types.js';

export interface SuperviseOptions {
  spec: ServiceSpec;
  env: Record<string, string>;
  registry: ProviderRegistry;
  logs: ServiceLogs;
  onStateChange(change: StateChange): void;
  onError(error: ServiceError): void;
  /** The services this one depends on. */
  dependencies(): readonly ReadinessSource[];
  readinessTimeoutMs: number;
  dependencyTimeoutMs: number;
  stopTimeoutMs: number;
  restart: RestartLimits;
  stableAfterMs: number;
}

export interface SupervisedService extends ReadinessSource {
  /** Start it unless it is up or on its way. Resolves when ready; rejects with `ServiceFailure` when it will not be. */
  start(): Promise<void>;
  /** Stop it (cancelling a pending start or restart); resolves once its process has exited. */
  stop(): Promise<void>;
  /** Stop, then start — unless another stop arrives meanwhile. Dependents waiting for it keep waiting. */
  restart(): Promise<void>;
  url(): string | undefined;
  snapshot(): ServiceSnapshot;
}

interface Outcome {
  phase: ServiceErrorPhase;
  message: string;
  exitCode?: number;
  /** Exited 0 while running: stopped, not failed. */
  clean?: boolean;
}

export function superviseService(options: SuperviseOptions): SupervisedService {
  const { spec, logs } = options;
  const readiness = readinessOf(spec);
  const policy = restartPolicyOf(spec);
  const timeoutMs = readiness.timeoutMs ?? options.readinessTimeoutMs;
  const changes = createListeners<void>();
  const lifecycle = createLifecycle(spec.id, (change) => {
    options.onStateChange(change);
    changes.emit();
  });
  const scheduler = createRestartScheduler();
  const serviceError = (phase: ServiceErrorPhase, message: string, willRestart = false, exitCode?: number): ServiceError => ({ serviceId: spec.id, phase, message, exitCode, willRestart });

  let active: ServiceRun | undefined;
  /** Ready for dependents: running, or a one-off that finished. */
  let satisfied = false;
  /** Between a `restart()`'s stop and its start. */
  let restarting = false;
  let attempt = 0;
  /** Counts `stop()` calls, coalesced ones too: a start queued behind a stop is dropped when another stop arrived. */
  let stopRequests = 0;
  let stopping: Promise<void> | undefined;
  /** The last process's exit: a launch waits for it (bounded), so a new process never races the old one for its port. */
  let lastExit: Promise<unknown> | undefined;
  let exitCode: number | undefined;
  let lastError: ServiceError | undefined;
  let downReason = serviceError('stopped', 'Not started.');

  function launch(): void {
    const run: ServiceRun = { controller: new AbortController() };
    active = run;
    satisfied = false;
    void execute(run);
  }

  async function execute(run: ServiceRun): Promise<void> {
    lifecycle.transition('preparing');
    try {
      await untilReady(options.dependencies(), { signal: run.controller.signal, timeoutMs: options.dependencyTimeoutMs });
    } catch (error) {
      const message = error instanceof ServiceFailure ? `Dependency "${error.error.serviceId}" is not available: ${error.error.message}` : `Dependencies not ready: ${messageOf(error)}`;
      return end(run, { phase: 'dependency', message });
    }
    if (active !== run) return;
    const resolution = options.registry.resolve(spec);
    if (!resolution.ok) return end(run, { phase: 'declined', message: resolution.reason });
    if (lastExit) await within(lastExit, { ms: options.stopTimeoutMs, onTimeout: () => undefined, signal: run.controller.signal, onAbort: () => undefined });
    if (active !== run) return;

    lifecycle.transition('starting');
    let handle: ServiceHandle;
    try {
      run.handlePromise = Promise.resolve(resolution.provider.start(spec, { env: options.env, signal: run.controller.signal }));
      handle = await run.handlePromise;
    } catch (error) {
      return end(run, { phase: 'start', message: messageOf(error) });
    }
    run.handle = handle;
    if (active !== run) {
      // Stopped while the provider was starting it: the stop owns the process, unless it gave up waiting.
      if (run.abandoned) lastExit = abandonProcess(handle);
      else void handle.output.cancel().catch(() => undefined);
      return;
    }
    logs.pipe(spec.id, handle.output);
    lastExit = handle.wait();
    void handle.wait().then((code) => exited(run, code));

    try {
      await within(handle.ready(), {
        ms: timeoutMs,
        onTimeout: () => {
          throw new Error(`Not ready after ${timeoutMs}ms (${readiness.kind} readiness).`);
        },
        signal: run.controller.signal,
      });
    } catch (error) {
      if (active !== run) return;
      const code = run.exitCode ?? (await exitWithin(handle, 0));
      if (active !== run) return;
      if (readiness.kind === 'exit-zero' && code === 0) {
        run.completed = true; // finished: its exit is its readiness, whatever ready() said
        return becomeReady(run);
      }
      return end(run, { phase: code === undefined ? 'readiness' : 'exit', message: messageOf(error), exitCode: code });
    }
    if (active === run) becomeReady(run);
  }

  function becomeReady(run: ServiceRun): void {
    run.readyAt = Date.now();
    lastError = undefined;
    lifecycle.transition('ready');
    satisfied = true;
    lifecycle.transition('running');
    if (run.completed) complete(run);
  }

  function exited(run: ServiceRun, code: number): void {
    run.exitCode = code;
    exitCode = code;
    if (active !== run) return;
    if (readiness.kind === 'exit-zero' && code === 0) {
      // A one-off finished: that IS its readiness, whatever the provider's ready() does.
      run.completed = true;
      if (lifecycle.state === 'running') complete(run);
      else if (lifecycle.state === 'starting') becomeReady(run);
      return;
    }
    end(run, { phase: 'exit', message: `Exited with code ${code}.`, exitCode: code, clean: lifecycle.state === 'running' && code === 0 });
  }

  /** A one-off service finished: stopped, and its readiness stays met for its dependents. */
  function complete(run: ServiceRun): void {
    active = undefined;
    run.controller.abort();
    logs.note(spec.id, 'Completed.');
    lifecycle.transition('stopped');
  }

  function end(run: ServiceRun, outcome: Outcome): void {
    if (active !== run) return;
    active = undefined;
    run.controller.abort();
    if (run.handle && run.exitCode === undefined) run.handle.kill('SIGKILL');
    if (run.readyAt !== undefined && Date.now() - run.readyAt >= options.stableAfterMs) attempt = 0;

    const terminal = outcome.phase === 'declined' || outcome.phase === 'dependency';
    const decision: RestartDecision = terminal ? { restart: false, reason: 'policy' } : restartDecision(policy, readiness.kind, outcome.exitCode ?? 1, attempt, options.restart);
    const error = serviceError(outcome.phase, outcome.message, decision.restart, outcome.exitCode);
    satisfied = false;
    downReason = error;
    // Scheduled before the transition, so waiters hearing it see a restart pending, not a service down.
    if (decision.restart) scheduler.schedule(decision.delayMs, launch);
    lifecycle.transition(outcome.clean ? 'stopped' : 'failed');

    if (outcome.clean) logs.note(spec.id, 'Exited with code 0.');
    else {
      lastError = error;
      logs.note(spec.id, `Failed (${outcome.phase}): ${outcome.message}`);
      options.onError(error);
    }
    if (decision.restart) {
      attempt += 1;
      logs.note(spec.id, `Restarting in ${decision.delayMs}ms (${policy}, attempt ${attempt}).`);
    }
  }

  async function stopNow(): Promise<void> {
    scheduler.cancel();
    const run = active;
    active = undefined;
    // Synchronously: from now on dependents do not see it as ready.
    satisfied = false;
    downReason = serviceError('stopped', 'Stopped.');
    if (ACTIVE_STATES.has(lifecycle.state)) {
      lifecycle.transition('stopping');
      const stopped = run ? await stopRun(run, options.stopTimeoutMs) : undefined;
      if (stopped) lastExit = stopped.wait();
      lifecycle.transition('stopped');
    } else if (lifecycle.state === 'failed') lifecycle.transition('stopped');
    else changes.emit(); // a finished one-off is no longer ready
  }

  const service: SupervisedService = {
    id: spec.id,
    async start() {
      const requests = stopRequests;
      if (stopping) await stopping;
      if (requests !== stopRequests) throw new ServiceFailure(serviceError('stopped', 'Stopped before it started.'));
      if (!satisfied && !ACTIVE_STATES.has(lifecycle.state) && !scheduler.pending) {
        attempt = 0;
        launch();
      }
      return untilReady([service]);
    },
    stop() {
      stopRequests += 1;
      stopping ??= stopNow().finally(() => (stopping = undefined));
      return stopping;
    },
    async restart() {
      restarting = true;
      try {
        const stopped = service.stop();
        const requests = stopRequests;
        await stopped;
        if (requests !== stopRequests) throw new ServiceFailure(serviceError('stopped', 'Stopped while restarting.'));
        attempt = 0;
        launch();
      } finally {
        restarting = false;
        changes.emit();
      }
      return untilReady([service]);
    },
    readiness: () => (satisfied ? 'ready' : ACTIVE_STATES.has(lifecycle.state) || scheduler.pending || restarting ? 'pending' : 'down'),
    failure: () => downReason,
    onChange: (listener) => changes.on(listener),
    url: () => active?.handle?.url(),
    snapshot: () => ({
      id: spec.id,
      type: spec.type,
      runtime: spec.runtime,
      role: roleOf(spec),
      state: lifecycle.state,
      port: spec.port,
      url: active?.handle?.url(),
      restarts: attempt,
      exitCode,
      error: lastError,
    }),
  };
  return service;
}
