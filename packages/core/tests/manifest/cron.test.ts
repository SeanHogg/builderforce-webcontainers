import { describe, expect, it } from 'vitest';
import { nextFire, parseCron, type CronSchedule } from '../../src/manifest/index.js';

function schedule(expression: string): CronSchedule {
  const result = parseCron(expression);
  if (!result.ok) throw new Error(result.reason);
  return result.schedule;
}

const at = (iso: string) => new Date(iso);
const next = (expression: string, after: string, timeZone?: string) => nextFire(schedule(expression), at(after), timeZone)?.toISOString();

describe('parseCron', () => {
  it('reads values, lists, ranges, steps and names', () => {
    const s = schedule('*/15 9-17/4 1,15 JAN-MAR mon-fri');
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([9, 13, 17]);
    expect(s.daysOfMonth).toEqual([1, 15]);
    expect(s.months).toEqual([1, 2, 3]);
    expect(s.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(s.dayOfMonthRestricted && s.dayOfWeekRestricted).toBe(true);
  });

  it('reads 7 as Sunday, `a/n` steps to the end, and macros', () => {
    expect(schedule('0 0 * * 7').daysOfWeek).toEqual([0]);
    expect(schedule('5/20 * * * *').minutes).toEqual([5, 25, 45]);
    expect(schedule('@daily').minutes).toEqual([0]);
    expect(schedule('@hourly').hours).toHaveLength(24);
  });

  it('refuses what it cannot read, with a reason', () => {
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', '* * * FOO *', '1,,2 * * * *', '0 0 31 2 *']) {
      const result = parseCron(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/\S/);
    }
  });
});

describe('nextFire (UTC)', () => {
  it('fires strictly after the given instant', () => {
    expect(next('*/5 * * * *', '2026-11-19T10:00:00Z')).toBe('2026-11-19T10:05:00.000Z');
    expect(next('*/5 * * * *', '2026-11-19T10:02:30Z')).toBe('2026-11-19T10:05:00.000Z');
    expect(next('0 3 * * *', '2026-11-19T03:00:00Z')).toBe('2026-11-20T03:00:00.000Z');
  });

  it('handles ranges with steps and days of week', () => {
    // 2026-11-19 is a Thursday.
    expect(next('30 9-17/4 * * MON', '2026-11-19T00:00:00Z')).toBe('2026-11-23T09:30:00.000Z');
    expect(next('0 12 * * 6,0', '2026-11-19T00:00:00Z')).toBe('2026-11-21T12:00:00.000Z');
  });

  it('rolls over months and years', () => {
    expect(next('0 0 1 * *', '2026-11-19T00:00:00Z')).toBe('2026-12-01T00:00:00.000Z');
    expect(next('0 0 1 * *', '2026-12-15T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(next('0 0 31 * *', '2026-11-01T00:00:00Z')).toBe('2026-12-31T00:00:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('matches either day field when both are restricted', () => {
    // The 1st of the month, or any Friday: Friday 2026-11-20 comes first.
    expect(next('0 0 1 * FRI', '2026-11-19T00:00:00Z')).toBe('2026-11-20T00:00:00.000Z');
  });
});

describe('nextFire (time zones)', () => {
  it('reads the schedule in the given IANA zone', () => {
    // 03:00 in New York on 2026-11-19 (EST, UTC-5) is 08:00 UTC.
    expect(next('0 3 * * *', '2026-11-19T00:00:00Z', 'America/New_York')).toBe('2026-11-19T08:00:00.000Z');
    // In July (EDT, UTC-4) it is 07:00 UTC.
    expect(next('0 3 * * *', '2026-07-01T00:00:00Z', 'America/New_York')).toBe('2026-07-01T07:00:00.000Z');
  });

  it('skips a wall time a spring-forward jump removes, and fires a repeated one once', () => {
    // 2026-03-08 02:30 does not exist in New York; the next 02:30 is on the 9th (EDT).
    expect(next('30 2 * * *', '2026-03-08T00:00:00Z', 'America/New_York')).toBe('2026-03-09T06:30:00.000Z');
    // 2026-11-01 01:30 happens twice; it fires at the first (EDT, 05:30 UTC) and not again at 06:30 UTC.
    expect(next('30 1 * * *', '2026-11-01T00:00:00Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
    expect(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York')).toBe('2026-11-02T06:30:00.000Z');
  });

  it('works for a zone ahead of UTC across a date line', () => {
    // 09:00 in Tokyo (UTC+9) is 00:00 UTC the same day.
    expect(next('0 9 * * *', '2026-11-19T01:00:00Z', 'Asia/Tokyo')).toBe('2026-11-20T00:00:00.000Z');
  });
});
