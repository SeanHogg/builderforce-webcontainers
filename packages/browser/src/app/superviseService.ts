/**
 * Run ONE service through its lifecycle: wait for its dependencies, start it on
 * the provider that accepts it, hold it to its readiness (with a timeout), and
 * when its process exits on its own apply its restart policy. A failure here
 * touches only this service; dependents that are already running keep running.
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
import { discardOutput, exitWithin, stopProcess } from './stopProcess.js';
import type { ServiceLogs } from './serviceLogs.js';
import type { ServiceError, ServiceErrorPhase, ServiceSnapshot } from './types.js';

export interface SuperviseOptions {
  spec: ServiceSpec;
  env: Record<string, string>;
  registry: ProviderRegistry;
  logs: ServiceLogs;
  onStateChange(change: StateChange): void;
  onError(error: ServiceError): void;
  /** Resolves once every dependency is ready; rejects with why one will not be (or when `signal` aborts). */
  dependenciesReady(signal: AbortSignal): Promise<void>;
  readinessTimeoutMs: number;
  stopTimeoutMs: number;
  restart: RestartLimits;
  stableAfterMs: number;
}

export interface SupervisedService {
  readonly id: string;
  /** Start it unless it is already starting or up. Resolves when ready; rejects with `ServiceFailure` when it fails for good. */
  start(): Promise<void>;
  /** Stop it (cancelling a pending start or restart); resolves once its process has exited. */
  stop(): Promise<void>;
  /** Settles when the service is ready, or has failed for good. */
  whenReady(): Promise<void>;
  url(): string | undefined;
  snapshot(): ServiceSnapshot;
}

/** Why a service will not become ready (it failed for good, or was stopped first). */
export class ServiceFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
    this.name = 'ServiceFailure';
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  readonly settled: boolean;
}

function deferred(): Deferred {
  let settled = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined); // a failure nobody waits for is not an unhandled rejection
  return {
    promise,
    resolve: () => ((settled = true), resolve()),
    reject: (error) => ((settled = true), reject(error)),
    get settled() {
      return settled;
    },
  };
}

/** One attempt at running the process. Callbacks from an attempt that is no longer `active` are ignored. */
interface Run {
  controller: AbortController;
  handle?: ServiceHandle;
  readyAt?: number;
  exitCode?: number;
  /** A one-off (`exit-zero`) service exited 0 before its readiness was seen. */
  completed?: boolean;
}

interface Outcome {
  phase: ServiceErrorPhase;
  message: string;
  exitCode?: number;
  /** Exited 0 while running: stopped, not failed. */
  clean?: boolean;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function superviseService(options: SuperviseOptions): SupervisedService {
  const { spec, logs } = options;
  const readiness = readinessOf(spec);
  const policy = restartPolicyOf(spec);
  const lifecycle = createLifecycle(spec.id, options.onStateChange);
  const timeoutMs = readiness.timeoutMs ?? options.readinessTimeoutMs;
  let ready = deferred();
  let active: Run | undefined;
  let attempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set while a restart is scheduled; `stop` clears it to cancel the restart. */
  let pendingRestart: object | undefined;
  let stopping: Promise<void> | undefined;
  let exitCode: number | undefined;
  let lastError: ServiceError | undefined;

  const launch = () => {
    const run: Run = { controller: new AbortController() };
    active = run;
    void execute(run);
  };

  async function execute(run: Run): Promise<void> {
    lifecycle.transition('preparing');
    try {
      await options.dependenciesReady(run.controller.signal);
    } catch (error) {
      return end(run, { phase: 'dependency', message: messageOf(error) });
    }
    if (active !== run) return;
    const resolution = options.registry.resolve(spec);
    if (!resolution.ok) return end(run, { phase: 'declined', message: resolution.reason });

    lifecycle.transition('starting');
    let handle: ServiceHandle;
    try {
      handle = await resolution.provider.start(spec, { env: options.env, signal: run.controller.signal });
    } catch (error) {
      return end(run, { phase: 'start', message: messageOf(error) });
    }
    if (active !== run) {
      // Stopped while the provider was starting it.
      handle.kill('SIGKILL');
      discardOutput(handle.output);
      return;
    }
    run.handle = handle;
    logs.pipe(spec.id, handle.output);
    void handle.wait().then((code) => exited(run, code));

    try {
      await withTimeout(handle.ready(), timeoutMs, `Not ready after ${timeoutMs}ms (${readiness.kind} readiness).`);
    } catch (error) {
      const code = run.exitCode ?? (await exitWithin(handle, 0));
      return end(run, { phase: code === undefined ? 'readiness' : 'exit', message: messageOf(error), exitCode: code });
    }
    if (active !== run) return;
    lifecycle.transition('ready');
    run.readyAt = Date.now();
    lastError = undefined;
    lifecycle.transition('running');
    ready.resolve();
    if (run.completed) complete();
  }

  function exited(run: Run, code: number): void {
    run.exitCode = code;
    exitCode = code;
    if (active !== run) return;
    if (readiness.kind === 'exit-zero' && code === 0) {
      run.completed = true;
      if (lifecycle.state === 'running') complete();
      return; // still `starting`: `execute` sees readiness, then completes it
    }
    const wasRunning = lifecycle.state === 'running';
    end(run, { phase: 'exit', message: `Exited with code ${code}.`, exitCode: code, clean: wasRunning && code === 0 });
  }

  /** A one-off service finished: stopped, and its readiness stays met for its dependents. */
  function complete(): void {
    active = undefined;
    logs.note(spec.id, 'Completed.');
    lifecycle.transition('stopped');
  }

  function end(run: Run, outcome: Outcome): void {
    if (active !== run) return;
    active = undefined;
    run.controller.abort();
    if (run.handle && run.exitCode === undefined) run.handle.kill('SIGKILL');
    if (run.readyAt !== undefined && Date.now() - run.readyAt >= options.stableAfterMs) attempt = 0;

    const terminal = outcome.phase === 'declined' || outcome.phase === 'dependency';
    const decision: RestartDecision = terminal ? { restart: false, reason: 'policy' } : restartDecision(policy, readiness.kind, outcome.exitCode ?? 1, attempt, options.restart);
    lifecycle.transition(outcome.clean ? 'stopped' : 'failed');
    // Leaving `running` (or never reaching it): dependents asking from now on wait for the next start.
    if (ready.settled) ready = deferred();

    let error: ServiceError | undefined;
    if (!outcome.clean) {
      error = { serviceId: spec.id, phase: outcome.phase, message: outcome.message, exitCode: outcome.exitCode, willRestart: decision.restart };
      lastError = error;
      logs.note(spec.id, `Failed (${outcome.phase}): ${outcome.message}`);
      options.onError(error);
    } else logs.note(spec.id, 'Exited with code 0.');

    if (decision.restart) {
      attempt += 1;
      logs.note(spec.id, `Restarting in ${decision.delayMs}ms (${policy}, attempt ${attempt}).`);
      scheduleRestart(decision.delayMs, run);
    } else {
      ready.reject(new ServiceFailure(error ?? { serviceId: spec.id, phase: 'exit', message: 'Exited with code 0.', exitCode: 0, willRestart: false }));
    }
  }

  /** Start again after `delayMs`, once the previous process has exited (it may still hold its port). */
  function scheduleRestart(delayMs: number, previous: Run): void {
    const token = {};
    pendingRestart = token;
    restartTimer = setTimeout(async () => {
      restartTimer = undefined;
      if (previous.handle && previous.exitCode === undefined) await exitWithin(previous.handle, options.stopTimeoutMs);
      if (pendingRestart !== token) return; // stopped meanwhile
      pendingRestart = undefined;
      launch();
    }, delayMs);
  }

  async function stopNow(): Promise<void> {
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    restartTimer = undefined;
    pendingRestart = undefined;
    const run = active;
    active = undefined;
    run?.controller.abort();
    if (ACTIVE_STATES.has(lifecycle.state)) {
      lifecycle.transition('stopping');
      if (run?.handle && run.exitCode === undefined) {
        const code = await stopProcess(run.handle, options.stopTimeoutMs);
        if (code === undefined) logs.note(spec.id, `Did not exit within ${options.stopTimeoutMs}ms of SIGKILL.`);
      }
      lifecycle.transition('stopped');
    } else if (lifecycle.state === 'failed') lifecycle.transition('stopped');
    if (!ready.settled) ready.reject(new ServiceFailure({ serviceId: spec.id, phase: 'exit', message: 'Stopped before it was ready.', willRestart: false }));
    ready = deferred();
  }

  const service: SupervisedService = {
    id: spec.id,
    async start() {
      if (stopping) await stopping;
      if (ACTIVE_STATES.has(lifecycle.state) || pendingRestart !== undefined) return ready.promise;
      if (ready.settled) ready = deferred();
      attempt = 0;
      const pending = ready.promise;
      launch();
      return pending;
    },
    stop() {
      stopping ??= stopNow().finally(() => (stopping = undefined));
      return stopping;
    },
    whenReady: () => ready.promise,
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
