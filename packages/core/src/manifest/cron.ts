/**
 * Five-field cron: `minute hour day-of-month month day-of-week`, each field `*`,
 * a value, a range `a-b`, a step `*\/n` / `a-b/n` / `a/n`, or a comma list of
 * those. Months and days of the week also take names (`JAN`, `MON`); day of
 * week 7 is Sunday. When both day fields are restricted a day matches either
 * (the classic cron rule). The `@yearly` … `@hourly` macros are accepted.
 * `nextFire` finds the next matching minute in UTC or any IANA time zone. Pure.
 */

export interface CronSchedule {
  /** The expression as written. */
  readonly source: string;
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  /** 0 = Sunday … 6 = Saturday. */
  readonly daysOfWeek: readonly number[];
  /** The field was not `*` (affects how the two day fields combine). */
  readonly dayOfMonthRestricted: boolean;
  readonly dayOfWeekRestricted: boolean;
}

export type CronParseResult = { ok: true; schedule: CronSchedule } | { ok: false; reason: string };

interface FieldRule {
  name: string;
  min: number;
  max: number;
  names?: readonly string[];
  /** Index offset of `names[0]`. */
  nameBase?: number;
}

const FIELDS: readonly FieldRule[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'], nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], nameBase: 0 },
];

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

/** The most days each month can have (February in a leap year). */
const MAX_DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseValue(text: string, rule: FieldRule): number | undefined {
  if (/^\d+$/.test(text)) return Number(text);
  const index = rule.names?.indexOf(text.toUpperCase()) ?? -1;
  return index >= 0 ? index + (rule.nameBase ?? 0) : undefined;
}

function parseField(text: string, rule: FieldRule): number[] | string {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined || !range) return `"${item}" in the ${rule.name} field is not a value, range or step.`;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return `Step "${stepText}" in the ${rule.name} field must be a positive whole number.`;
      step = Number(stepText);
    }
    let from: number | undefined;
    let to: number | undefined;
    if (range === '*') {
      from = rule.min;
      to = rule.max;
    } else {
      const [startText, endText, more] = range.split('-');
      if (more !== undefined || !startText) return `"${range}" in the ${rule.name} field is not a value or range.`;
      from = parseValue(startText, rule);
      // `a/n` runs from `a` to the field's end.
      to = endText !== undefined ? parseValue(endText, rule) : stepText !== undefined ? rule.max : from;
    }
    if (from === undefined || to === undefined) return `"${range}" in the ${rule.name} field is not a value.`;
    if (from < rule.min || to > rule.max || from > to) return `"${range}" is outside the ${rule.name} field's range ${rule.min}-${rule.max}.`;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses an expression; a reason a person can read when it cannot. */
export function parseCron(expression: string): CronParseResult {
  const source = expression.trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, reason: `A cron schedule has 5 fields (minute hour day-of-month month day-of-week); "${source}" has ${parts.length}.` };
  const fields: number[][] = [];
  for (let index = 0; index < 5; index++) {
    const parsed = parseField(parts[index]!, FIELDS[index]!);
    if (typeof parsed === 'string') return { ok: false, reason: parsed };
    fields.push(parsed);
  }
  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = fields as [number[], number[], number[], number[], number[]];
  const daysOfWeek = [...new Set(rawDaysOfWeek.map((day) => day % 7))].sort((a, b) => a - b);
  const dayOfMonthRestricted = !parts[2]!.startsWith('*');
  const dayOfWeekRestricted = !parts[4]!.startsWith('*');
  // A day of month no chosen month has (`31 2`) never fires, unless the day of week can fire instead.
  if (dayOfMonthRestricted && !dayOfWeekRestricted && !months.some((month) => daysOfMonth.some((day) => day <= MAX_DAYS_IN_MONTH[month - 1]!))) {
    return { ok: false, reason: `"${source}" never fires: no chosen month has the chosen day.` };
  }
  return { ok: true, schedule: { source, minutes, hours, daysOfMonth, months, daysOfWeek, dayOfMonthRestricted, dayOfWeekRestricted } };
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Whether `timeZone` is an IANA zone this engine knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time in `timeZone` at `instantMs`, encoded as if it were UTC. */
function wallClockMs(instantMs: number, timeZone: string): number {
  if (timeZone === 'UTC') return instantMs;
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
}

/**
 * The instant a wall-clock time in `timeZone` happens at, or undefined when that
 * wall time does not exist (skipped by a daylight-saving jump). An ambiguous
 * time (repeated by a fall-back) resolves to its earlier instant.
 */
function instantOfWallClock(wallMs: number, timeZone: string): number | undefined {
  if (timeZone === 'UTC') return wallMs;
  const candidates = new Set<number>();
  // The offset at a guess near the answer; try the offsets on both sides of a transition.
  for (const probe of [wallMs - 86_400_000, wallMs, wallMs + 86_400_000]) {
    const offset = wallClockMs(probe, timeZone) - probe;
    const instant = wallMs - offset;
    if (wallClockMs(instant, timeZone) === wallMs) candidates.add(instant);
  }
  return candidates.size === 0 ? undefined : Math.min(...candidates);
}

// ---------------------------------------------------------------------------
// Next fire
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
/** Give up after this many years without a match. */
const SEARCH_YEARS = 8;

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const dom = schedule.daysOfMonth.includes(date.getUTCDate());
  const dow = schedule.daysOfWeek.includes(date.getUTCDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dom || dow;
  if (schedule.dayOfMonthRestricted) return dom;
  if (schedule.dayOfWeekRestricted) return dow;
  return true;
}

/** The next wall-clock minute at or after `wallMs` the schedule matches (searched in UTC fields). */
function nextWallMatch(schedule: CronSchedule, wallMs: number): number | undefined {
  const date = new Date(wallMs);
  const lastYear = date.getUTCFullYear() + SEARCH_YEARS;
  while (date.getUTCFullYear() <= lastYear) {
    if (!schedule.months.includes(date.getUTCMonth() + 1)) {
      date.setUTCMonth(date.getUTCMonth() + 1, 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(schedule, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.includes(date.getUTCHours())) {
      date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.includes(date.getUTCMinutes())) {
      date.setUTCMinutes(date.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return undefined;
}

/**
 * The first instant strictly after `after` at which the schedule fires, read in
 * `timeZone` (default UTC). A wall time skipped by a daylight-saving jump does
 * not fire; a repeated one fires once. Undefined when nothing fires within
 * eight years. Throws a RangeError for an unknown time zone.
 */
export function nextFire(schedule: CronSchedule, after: Date, timeZone = 'UTC'): Date | undefined {
  const afterMs = after.getTime();
  // Start at the next whole minute in wall-clock time.
  let wall = Math.floor(wallClockMs(afterMs, timeZone) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let attempts = 0; attempts < 10_000; attempts++) {
    const match = nextWallMatch(schedule, wall);
    if (match === undefined) return undefined;
    const instant = instantOfWallClock(match, timeZone);
    if (instant !== undefined && instant > afterMs) return new Date(instant);
    wall = match + MINUTE_MS;
  }
  return undefined;
}
