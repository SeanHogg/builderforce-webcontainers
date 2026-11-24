/**
 * The job scheduler: fires the manifest's cron triggers (`jobs` and the cron
 * triggers of `agents`) in this runtime, only while it holds the runtime lease
 * (one tab fires; the others stay quiet until ownership moves to them). The
 * schedule is read by core's cron reader (`parseCron` / `nextFire`), so
 * daylight-saving jumps follow its rules. Clock and timers are injectable.
 */
import {
  isValidTimeZone,
  nextFire,
  parseCron,
  type AppManifest,
  type CronSchedule,
  type JobConcurrency,
  type MissedPolicy,
} from '@seanhogg/builderforce-webcontainers-core/manifest';
import type { AgentHostPort, EnvCorrelation } from '@seanhogg/builderforce-webcontainers-core';
import type { RuntimeLease } from '../shared/runtimeLease.js';

/** One cron trigger the scheduler fires. */
export interface ScheduledTrigger {
  /** Unique among the triggers: `job:<name>` or `agent:<agentId>:<index>`. */
  id: string;
  source: 'job' | 'agent';
  /** The job name or agent id the trigger starts. */
  target: string;
  cron: string;
  /** IANA time zone. Default `UTC`. */
  timeZone?: string;
  /** Default `allow` (`forbid`: skip a fire while one runs; `replace`: abort the running one). */
  concurrency?: JobConcurrency;
  /** Default `skip`. */
  missed?: MissedPolicy;
}

/** Why a fire did not run. */
export type SkipReason = 'overlap' | 'missed';

/** A trigger the scheduler never arms; the manifest already reports it as an issue. */
export interface InvalidTrigger {
  trigger: ScheduledTrigger;
  reason: string;
}

export type TriggerFire = (trigger: ScheduledTrigger, at: Date, signal: AbortSignal) => Promise<void>;

export interface JobSchedulerOptions {
  triggers: readonly ScheduledTrigger[];
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Runs one fire; `at` is the scheduled instant (for a `run-once` catch-up, the earliest missed one). Settles when the run ends. */
  onFire: TriggerFire;
  /** A rejected `onFire`. */
  onError: (error: unknown, trigger: ScheduledTrigger, at: Date) => void;
  /** A fire that did not run (overlap under `forbid`, or missed under `skip`). */
  onSkip?: (trigger: ScheduledTrigger, at: Date, reason: SkipReason) => void;
  lease: RuntimeLease;
  /** The instant from which fires count as missed on the first start (a host that persisted its last run). Default: the start. */
  since?: Date;
}

export interface JobScheduler {
  readonly invalid: readonly InvalidTrigger[];
  start(): void;
  /** Disarms every timer; running fires keep running. */
  stop(): void;
}

/** The longest delay `setTimeout` honours (a signed 32-bit millisecond count); longer waits are chunked. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** A fire the timer reaches this late or less is on time (background tabs throttle timers to about a minute). */
export const ON_TIME_TOLERANCE_MS = 60_000;
const DEFAULT_TIME_ZONE = 'UTC';
const DEFAULT_CONCURRENCY: JobConcurrency = 'allow';
const DEFAULT_MISSED: MissedPolicy = 'skip';

/** Every cron trigger of the manifest: one per job, one per agent `cron` trigger. */
export function collectTriggers(manifest: AppManifest): ScheduledTrigger[] {
  const triggers: ScheduledTrigger[] = [];
  for (const [name, job] of Object.entries(manifest.jobs ?? {})) {
    triggers.push({ id: `job:${name}`, source: 'job', target: name, cron: job.schedule, timeZone: job.timezone, concurrency: job.concurrency, missed: job.missed });
  }
  for (const [agentId, agent] of Object.entries(manifest.agents ?? {})) {
    (agent.triggers ?? []).forEach((trigger, index) => {
      if ('cron' in trigger) triggers.push({ id: `agent:${agentId}:${index}`, source: 'agent', target: agentId, cron: trigger.cron, timeZone: trigger.timezone });
    });
  }
  return triggers;
}

interface Armed {
  readonly trigger: ScheduledTrigger;
  readonly schedule: CronSchedule;
  readonly timeZone: string;
  /** Fires after this instant are due; earlier ones were handled. */
  watermark: number | undefined;
  handle: unknown;
  readonly running: Set<AbortController>;
}

export function createJobScheduler(options: JobSchedulerOptions): JobScheduler {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const { lease } = options;
  const invalid: InvalidTrigger[] = [];
  const entries: Armed[] = [];
  for (const trigger of options.triggers) {
    const parsed = parseCron(trigger.cron);
    const timeZone = trigger.timeZone ?? DEFAULT_TIME_ZONE;
    if (!parsed.ok) invalid.push({ trigger, reason: parsed.reason });
    else if (!isValidTimeZone(timeZone)) invalid.push({ trigger, reason: `"${timeZone}" is not an IANA time zone.` });
    else entries.push({ trigger, schedule: parsed.schedule, timeZone, watermark: options.since?.getTime(), handle: undefined, running: new Set() });
  }

  let started = false;
  let listening = false;
  /** The fencing token of the ownership the timers are armed under; undefined while disarmed. */
  let fence: number | undefined;

  function disarm(): void {
    for (const entry of entries) {
      if (entry.handle !== undefined) clearTimer(entry.handle);
      entry.handle = undefined;
    }
    fence = undefined;
  }

  function armAll(): void {
    const state = lease.state;
    if (!started || state.kind !== 'owner' || state.fencingToken === fence) return;
    // Ownership changed under armed timers: start over as the new owner.
    if (fence !== undefined) dropOwnership();
    fence = state.fencingToken;
    const startMs = now().getTime();
    for (const entry of entries) {
      entry.watermark ??= startMs;
      // Fires missed before this start are judged on the first wake.
      wake(entry);
    }
  }

  function arm(entry: Armed, dueMs: number): void {
    const delay = Math.max(0, dueMs - now().getTime());
    entry.handle = setTimer(() => {
      entry.handle = undefined;
      wake(entry);
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
  }

  /** Whether this scheduler still owns the lease it armed under; drops everything when not. */
  function stillOwner(): boolean {
    const state = lease.state;
    if (fence !== undefined && state.kind === 'owner' && state.fencingToken === fence && lease.assertFence(fence)) return true;
    dropOwnership();
    return false;
  }

  function dropOwnership(): void {
    disarm();
    // Another owner fires meanwhile: nothing this scheduler did not run counts as missed.
    for (const entry of entries) entry.watermark = undefined;
  }

  function wake(entry: Armed): void {
    if (!started || !stillOwner()) return;
    const nowMs = now().getTime();
    const watermark = entry.watermark ?? nowMs;
    const first = nextFire(entry.schedule, new Date(watermark), entry.timeZone);
    if (first === undefined) return; // Never fires again.
    if (first.getTime() > nowMs) {
      arm(entry, first.getTime());
      return;
    }
    // At least one fire is due: the latest within tolerance is on time, the rest were missed.
    const recent = nextFire(entry.schedule, new Date(Math.max(watermark, nowMs - ON_TIME_TOLERANCE_MS)), entry.timeZone);
    const onTime = recent !== undefined && recent.getTime() <= nowMs ? recent : undefined;
    entry.watermark = nowMs;
    const missedSome = onTime === undefined || first.getTime() < onTime.getTime();
    if (missedSome && (entry.trigger.missed ?? DEFAULT_MISSED) === 'skip') options.onSkip?.(entry.trigger, first, 'missed');
    if (onTime) fire(entry, onTime);
    else if (entry.trigger.missed === 'run-once') fire(entry, first);
    wake(entry);
  }

  function fire(entry: Armed, at: Date): void {
    const concurrency = entry.trigger.concurrency ?? DEFAULT_CONCURRENCY;
    if (concurrency === 'forbid' && entry.running.size > 0) {
      options.onSkip?.(entry.trigger, at, 'overlap');
      return;
    }
    if (concurrency === 'replace') for (const running of entry.running) running.abort();
    const controller = new AbortController();
    entry.running.add(controller);
    let run: Promise<void>;
    try {
      run = options.onFire(entry.trigger, at, controller.signal);
    } catch (error) {
      run = Promise.reject(error);
    }
    run.then(
      () => entry.running.delete(controller),
      (error: unknown) => {
        entry.running.delete(controller);
        options.onError(error, entry.trigger, at);
      },
    );
  }

  return {
    invalid,
    start() {
      if (started) return;
      started = true;
      if (!listening) {
        listening = true;
        lease.onOwner(armAll);
      }
      armAll();
    },
    stop() {
      started = false;
      disarm();
    },
  };
}

export interface AgentTriggerFireOptions {
  /** The task the agent is started with. Default: names the trigger and the scheduled instant. */
  task?: (trigger: ScheduledTrigger, at: Date) => string;
}

/**
 * An `onFire` for agent triggers: starts the agent through the host, settles
 * when the run's event stream ends, and cancels the run when the scheduler
 * aborts it (`replace`).
 */
export function agentTriggerFire(
  host: AgentHostPort,
  correlation: Omit<EnvCorrelation, 'agentId' | 'correlationId'>,
  options: AgentTriggerFireOptions = {},
): TriggerFire {
  const task = options.task ?? ((trigger, at) => `Scheduled run of ${trigger.target} (${trigger.cron}) for ${at.toISOString()}`);
  return async (trigger, at, signal) => {
    if (trigger.source !== 'agent') throw new Error(`Trigger ${trigger.id} is not an agent trigger.`);
    const { runId } = await host.start(trigger.target, {
      task: task(trigger, at),
      correlation: { ...correlation, agentId: trigger.target, correlationId: `${trigger.id}@${at.toISOString()}` },
    });
    // A cancelled run's stream ends too; a failed cancel fails the fire.
    let cancelled: Promise<{ error: unknown } | undefined> | undefined;
    const cancel = (): void => {
      cancelled ??= host.cancel(runId).then(() => undefined, (error: unknown) => ({ error }));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    try {
      for await (const _event of host.events(runId)) {
        // Drained: the run ends when its event stream does.
      }
    } finally {
      signal.removeEventListener('abort', cancel);
    }
    const failure = await cancelled;
    if (failure) throw failure.error;
  };
}
