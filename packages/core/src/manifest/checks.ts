/**
 * The field checks every manifest validator shares (`validate.ts`, `agents.ts`):
 * each pushes a typed issue and never throws on a value of the wrong shape.
 */
import { SERVICE_ID } from '../app/validateSpec.js';
import { isValidTimeZone, parseCron } from './cron.js';
import { parseDuration } from './duration.js';
import { manifestIssue, type ManifestIssue } from './issues.js';
import { isRecord, isSafeKey } from './overrides.js';

export type Issues = ManifestIssue[];

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A record section, or an issue when it is present but not an object. */
export function section(value: unknown, path: string, issues: Issues): Record<string, unknown> {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an object keyed by id.' }));
  return {};
}

export function checkEnum(value: unknown, allowed: readonly string[], path: string, issues: Issues): void {
  if (value !== undefined && !(typeof value === 'string' && allowed.includes(value))) {
    issues.push(manifestIssue('invalid-value', path, { value: String(value), detail: `Use one of: ${allowed.join(', ')}.` }));
  }
}

export function checkType(value: unknown, type: 'string' | 'boolean' | 'number', path: string, issues: Issues): void {
  if (value !== undefined && typeof value !== type) issues.push(manifestIssue('invalid-value', path, { value: String(value), detail: `Expected a ${type}.` }));
}

export function stringArray(value: unknown, path: string, issues: Issues): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a list of strings.' }));
  return [];
}

/** The field's value, or undefined (and a `missing-field` issue) when it is absent or empty. */
export function required(entry: Record<string, unknown>, field: string, path: string, issues: Issues): unknown {
  const value = entry[field];
  if (value !== undefined && value !== null && value !== '') return value;
  issues.push(manifestIssue('missing-field', path, { value: field }));
  return undefined;
}

export function checkDuration(value: unknown, path: string, issues: Issues): void {
  if (value !== undefined && (typeof value !== 'string' || parseDuration(value) === undefined)) issues.push(manifestIssue('invalid-duration', path, { value: String(value) }));
}

export function checkIds(entries: Record<string, unknown>, sectionName: string, issues: Issues): void {
  // A prototype key (`constructor`, `prototype`) is never an id: no manifest walker copies one.
  for (const id of Object.keys(entries)) if (!SERVICE_ID.test(id) || !isSafeKey(id)) issues.push(manifestIssue('invalid-id', `${sectionName}.${id}`, { value: id }));
}

/** A five-field cron schedule, read by the one cron parser (`jobs` and agent triggers). */
export function checkSchedule(schedule: unknown, path: string, issues: Issues): void {
  const parsed = typeof schedule === 'string' ? parseCron(schedule) : { ok: false as const, reason: 'Expected a string.' };
  if (!parsed.ok) issues.push(manifestIssue('invalid-schedule', path, { value: String(schedule), detail: parsed.reason }));
}

/** An optional IANA time zone. */
export function checkTimeZone(timeZone: unknown, path: string, issues: Issues): void {
  if (timeZone !== undefined && !(typeof timeZone === 'string' && isValidTimeZone(timeZone))) issues.push(manifestIssue('invalid-timezone', path, { value: String(timeZone) }));
}
