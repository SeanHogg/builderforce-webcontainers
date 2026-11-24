import { describe, expect, it } from 'vitest';
import type { AgentHostEvent, AgentHostPort, EnvCorrelation } from '@seanhogg/builderforce-webcontainers-core';
import type { AppManifest } from '@seanhogg/builderforce-webcontainers-core/manifest';
import {
  agentTriggerFire,
  collectTriggers,
  createJobScheduler,
  MAX_TIMER_DELAY_MS,
  type JobSchedulerOptions,
  type ScheduledTrigger,
  type SkipReason,
} from '../../src/app/jobScheduler.js';
import type { LeaseState, RuntimeLease } from '../../src/shared/runtimeLease.js';

/** A clock and timer queue the test moves by hand. */
function fakeTime(startIso: string) {
  let clockMs = Date.parse(startIso);
  let nextId = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  const delays: number[] = [];
  const runDue = (): void => {
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= clockMs).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return {
    delays,
    now: () => new Date(clockMs),
    setTimer: (fn: () => void, ms: number) => {
      delays.push(ms);
      timers.set(++nextId, { fn, at: clockMs + ms });
      return nextId;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    /** Runs each timer at its own time, up to `iso`. */
    advanceTo(iso: string) {
      const target = Date.parse(iso);
      for (;;) {
        const next = [...timers.values()].filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clockMs = Math.max(clockMs, next.at);
        runDue();
      }
      clockMs = target;
    },
    /** The clock jumps (a sleeping machine); timers run late, at the new time. */
    jumpTo(iso: string) {
      clockMs = Date.parse(iso);
      runDue();
    },
  };
}

function fakeLease(initial: LeaseState): RuntimeLease & { grant(token: number): void } {
  let state = initial;
  const listeners: Array<() => void> = [];
  return {
    get state() {
      return state;
    },
    onOwner(listener) {
      listeners.push(listener);
    },
    release() {
      state = { kind: 'owned-elsewhere' };
    },
    assertFence(token) {
      return state.kind === 'owner' && state.fencingToken === token;
    },
    grant(token) {
      state = { kind: 'owner', fencingToken: token };
      for (const listener of listeners) listener();
    },
  };
}

const owner = (): ReturnType<typeof fakeLease> => fakeLease({ kind: 'owner', fencingToken: 1 });

/** An agent host that records each started run in a run store; each run's events end at once. */
function fakeHost() {
  const runs: Array<{ runId: string; agentId: string; task: string; correlation: EnvCorrelation }> = [];
  const host: AgentHostPort = {
    async start(agentId, input) {
      const runId = `run-${runs.length + 1}`;
      runs.push({ runId, agentId, ...input });
      return { runId };
    },
    async steer() {},
    async cancel() {},
    async *events(): AsyncIterable<AgentHostEvent> {},
  };
  return { host, runs };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function recorder() {
  const fired: Array<{ id: string; at: string }> = [];
  const skipped: Array<{ id: string; at: string; reason: SkipReason }> = [];
  const errors: unknown[] = [];
  return {
    fired,
    skipped,
    errors,
    onFire: async (t: ScheduledTrigger, at: Date) => {
      fired.push({ id: t.id, at: at.toISOString() });
    },
    onSkip: (t: ScheduledTrigger, at: Date, reason: SkipReason) => {
      skipped.push({ id: t.id, at: at.toISOString(), reason });
    },
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
}

function schedulerWith(time: ReturnType<typeof fakeTime>, options: Omit<JobSchedulerOptions, 'now' | 'setTimer' | 'clearTimer'>) {
  return createJobScheduler({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, ...options });
}

const trigger = (cron: string, extra: Partial<ScheduledTrigger> = {}): ScheduledTrigger => ({ id: 'job:t', source: 'job', target: 't', cron, ...extra });

describe('collectTriggers', () => {
  it('reads jobs and the cron triggers of agents', () => {
    const manifest = {
      jobs: { backup: { schedule: '0 3 * * *', timezone: 'Europe/London', concurrency: 'forbid', missed: 'run-once', run: { service: 'api', command: 'backup' } } },
      agents: { triage: { role: 'triage', triggers: [{ manual: true }, { cron: '*/15 * * * *', timezone: 'America/New_York' }, { service: 'api', event: 'x' }] } },
    } as unknown as AppManifest;
    expect(collectTriggers(manifest)).toEqual([
      { id: 'job:backup', source: 'job', target: 'backup', cron: '0 3 * * *', timeZone: 'Europe/London', concurrency: 'forbid', missed: 'run-once' },
      { id: 'agent:triage:1', source: 'agent', target: 'triage', cron: '*/15 * * * *', timeZone: 'America/New_York' },
    ]);
  });
});

describe('createJobScheduler', () => {
  it('starts a declared cron agent with no user present; the run lands in the run store', async () => {
    const time = fakeTime('2026-01-01T02:59:00Z');
    const { host, runs } = fakeHost();
    const rec = recorder();
    const manifest = { agents: { nightly: { role: 'maintainer', triggers: [{ cron: '0 3 * * *' }] } } } as unknown as AppManifest;
    const scheduler = schedulerWith(time, {
      triggers: collectTriggers(manifest),
      onFire: agentTriggerFire(host, { environmentId: 'env-1', runtimeId: 'rt-1' }),
      onError: rec.onError,
      lease: owner(),
    });
    scheduler.start();
    time.advanceTo('2026-01-01T03:00:30Z');
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentId: 'nightly',
      correlation: { environmentId: 'env-1', runtimeId: 'rt-1', agentId: 'nightly', correlationId: 'agent:nightly:0@2026-01-01T03:00:00.000Z' },
    });
    expect(rec.errors).toEqual([]);
    scheduler.stop();
    expect(time.pending()).toBe(0);
  });

  it('a scheduler without the lease never fires, and starts firing when ownership arrives', () => {
    const time = fakeTime('2026-01-01T00:00:00Z');
    const rec = recorder();
    const lease = fakeLease({ kind: 'owned-elsewhere' });
    const scheduler = schedulerWith(time, { triggers: [trigger('* * * * *')], ...rec, lease });
    scheduler.start();
    time.advanceTo('2026-01-01T01:00:00Z');
    expect(rec.fired).toEqual([]);
    expect(time.pending()).toBe(0);
    lease.grant(7);
    time.advanceTo('2026-01-01T01:02:00Z');
    expect(rec.fired.map((f) => f.at)).toEqual(['2026-01-01T01:01:00.000Z', '2026-01-01T01:02:00.000Z']);
  });

  it('stops firing when the lease moves elsewhere', () => {
    const time = fakeTime('2026-01-01T00:00:00Z');
    const rec = recorder();
    const lease = owner();
    schedulerWith(time, { triggers: [trigger('* * * * *')], ...rec, lease }).start();
    time.advanceTo('2026-01-01T00:01:00Z');
    lease.release();
    time.advanceTo('2026-01-01T00:10:00Z');
    expect(rec.fired).toHaveLength(1);
    expect(time.pending()).toBe(0);
  });

  it('reads the wall clock through nextFire across the spring-forward (America/New_York)', () => {
    const time = fakeTime('2026-03-07T00:00:00Z');
    const rec = recorder();
    const triggers = [
      trigger('0 9 * * *', { id: 'job:nine', timeZone: 'America/New_York' }),
      // 02:30 does not exist on 2026-03-08 in New York.
      trigger('30 2 * * *', { id: 'job:skipped', timeZone: 'America/New_York' }),
    ];
    schedulerWith(time, { triggers, ...rec, lease: owner() }).start();
    time.advanceTo('2026-03-09T23:00:00Z');
    expect(rec.fired.filter((f) => f.id === 'job:nine').map((f) => f.at)).toEqual([
      '2026-03-07T14:00:00.000Z', // EST
      '2026-03-08T13:00:00.000Z', // EDT
      '2026-03-09T13:00:00.000Z',
    ]);
    expect(rec.fired.filter((f) => f.id === 'job:skipped').map((f) => f.at)).toEqual(['2026-03-07T07:30:00.000Z', '2026-03-09T06:30:00.000Z']);
  });

  it('skips an invalid cron or time zone (already manifest issues) and fires the rest', () => {
    const time = fakeTime('2026-01-01T00:00:00Z');
    const rec = recorder();
    const scheduler = schedulerWith(time, {
      triggers: [trigger('61 * * * *', { id: 'job:bad-cron' }), trigger('* * * * *', { id: 'job:bad-zone', timeZone: 'Mars/Olympus' }), trigger('* * * * *', { id: 'job:ok' })],
      ...rec,
      lease: owner(),
    });
    expect(scheduler.invalid.map((i) => i.trigger.id)).toEqual(['job:bad-cron', 'job:bad-zone']);
    scheduler.start();
    time.advanceTo('2026-01-01T00:02:00Z');
    expect(rec.fired.map((f) => f.id)).toEqual(['job:ok', 'job:ok']);
  });

  it('concurrency forbid skips a fire while one runs; replace aborts the running one', async () => {
    const time = fakeTime('2026-01-01T00:00:00Z');
    const rec = recorder();
    const signals: AbortSignal[] = [];
    let finish: (() => void) | undefined;
    const scheduler = schedulerWith(time, {
      triggers: [trigger('* * * * *', { id: 'job:forbid', concurrency: 'forbid' }), trigger('* * * * *', { id: 'job:replace', concurrency: 'replace' })],
      onFire: (t, _at, signal) => {
        if (t.id === 'job:replace') {
          signals.push(signal);
          return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        }
        rec.fired.push({ id: t.id, at: '' });
        return new Promise<void>((resolve) => (finish = resolve));
      },
      onSkip: rec.onSkip,
      onError: rec.onError,
      lease: owner(),
    });
    scheduler.start();
    time.advanceTo('2026-01-01T00:03:00Z');
    expect(rec.fired).toHaveLength(1);
    expect(rec.skipped).toEqual([
      { id: 'job:forbid', at: '2026-01-01T00:02:00.000Z', reason: 'overlap' },
      { id: 'job:forbid', at: '2026-01-01T00:03:00.000Z', reason: 'overlap' },
    ]);
    expect(signals.map((s) => s.aborted)).toEqual([true, true, false]);
    finish!();
    await flush();
    time.advanceTo('2026-01-01T00:04:00Z');
    expect(rec.fired).toHaveLength(2);
  });

  it('missed fires: skip drops them, run-once runs one on wake, an on-time fire covers the rest', () => {
    const time = fakeTime('2026-01-01T00:30:00Z');
    const rec = recorder();
    const triggers = [
      trigger('0 * * * *', { id: 'job:skip', missed: 'skip' }),
      trigger('0 * * * *', { id: 'job:once', missed: 'run-once' }),
      trigger('* * * * *', { id: 'job:minutely', missed: 'run-once' }),
    ];
    schedulerWith(time, { triggers, ...rec, lease: owner() }).start();
    // The machine sleeps through five hourly fires and wakes at 05:30 (not near any hourly fire).
    time.jumpTo('2026-01-01T05:30:00Z');
    expect(rec.fired.filter((f) => f.id === 'job:skip')).toEqual([]);
    expect(rec.skipped.filter((s) => s.id === 'job:skip')).toEqual([{ id: 'job:skip', at: '2026-01-01T01:00:00.000Z', reason: 'missed' }]);
    expect(rec.fired.filter((f) => f.id === 'job:once')).toEqual([{ id: 'job:once', at: '2026-01-01T01:00:00.000Z' }]);
    // 05:30 itself is a minutely fire, on time: it runs once and stands for the missed ones.
    expect(rec.fired.filter((f) => f.id === 'job:minutely')).toEqual([{ id: 'job:minutely', at: '2026-01-01T05:30:00.000Z' }]);
    // Afterwards the schedule carries on normally.
    time.advanceTo('2026-01-01T06:00:00Z');
    expect(rec.fired.filter((f) => f.id === 'job:once').map((f) => f.at)).toEqual(['2026-01-01T01:00:00.000Z', '2026-01-01T06:00:00.000Z']);
    expect(rec.fired.filter((f) => f.id === 'job:skip').map((f) => f.at)).toEqual(['2026-01-01T06:00:00.000Z']);
  });

  it('judges fires missed between stop and start by the policy', () => {
    const time = fakeTime('2026-01-01T00:30:00Z');
    const rec = recorder();
    const scheduler = schedulerWith(time, { triggers: [trigger('0 * * * *', { missed: 'run-once' })], ...rec, lease: owner() });
    scheduler.start();
    scheduler.stop();
    time.advanceTo('2026-01-01T03:30:00Z');
    expect(rec.fired).toEqual([]);
    scheduler.start();
    expect(rec.fired).toEqual([{ id: 'job:t', at: '2026-01-01T01:00:00.000Z' }]);
  });

  it('chunks a wait longer than setTimeout allows', () => {
    const time = fakeTime('2026-01-02T00:00:00Z');
    const rec = recorder();
    schedulerWith(time, { triggers: [trigger('@yearly')], ...rec, lease: owner() }).start();
    time.advanceTo('2027-01-01T00:00:00Z');
    expect(rec.fired.map((f) => f.at)).toEqual(['2027-01-01T00:00:00.000Z']);
    expect(Math.max(...time.delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    expect(time.delays.length).toBeGreaterThan(1);
  });

  it('reports a rejected fire through onError', async () => {
    const time = fakeTime('2026-01-01T00:00:00Z');
    const rec = recorder();
    const failure = new Error('boom');
    schedulerWith(time, { triggers: [trigger('* * * * *')], onFire: () => Promise.reject(failure), onError: rec.onError, lease: owner() }).start();
    time.advanceTo('2026-01-01T00:01:00Z');
    await flush();
    expect(rec.errors).toEqual([failure]);
  });
});
