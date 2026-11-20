/**
 * Environments: pick one by name and apply its `overrides` to the base
 * manifest. Entries are keyed by id, so an override changes one service,
 * resource or job, and within it one key at a time, all the way down. Arrays
 * (`args`, `uses`, …) are values: an override replaces one array, never the
 * whole list of services. An override never adds an entry the base lacks.
 */
import { manifestIssue, type ManifestIssue } from './issues.js';
import { DEFAULT_ENVIRONMENTS, type AppManifest, type EnvironmentSpec, type ManifestOverrides, type ResolvedEnvironment } from './types.js';

const OVERRIDABLE = ['services', 'resources', 'jobs'] as const satisfies readonly (keyof ManifestOverrides)[];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Keys never copied from a parsed manifest: assigning `__proto__` would replace
 * the merged object's prototype, and `constructor`/`prototype` reach the
 * prototype chain of whatever reads them next. `JSON.parse` makes all three
 * plain own keys, so they arrive in `patch` like any other.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether `key` may be copied from a manifest object (never a prototype key). */
export function isSafeKey(key: string): boolean {
  return !FORBIDDEN_KEYS.has(key);
}

/** Whether `record` declares `key` itself (never through its prototype: `constructor`, `toString`…). */
export function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return isSafeKey(key) && Object.hasOwn(record, key);
}

/** `patch` merged over `base` per key, recursively; anything that is not a plain object (arrays included) replaces. Prototype keys are skipped. */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) if (isSafeKey(key)) merged[key] = value;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && isSafeKey(key)) merged[key] = mergeDeep(Object.hasOwn(merged, key) ? merged[key] : undefined, value);
  }
  return merged as T;
}

/** The environments a manifest has: its own, or `DEFAULT_ENVIRONMENTS` when it declares none. */
export function environmentsOf(manifest: AppManifest): Record<string, EnvironmentSpec> {
  const declared = isRecord(manifest.environments) ? manifest.environments : undefined;
  return declared && Object.keys(declared).length > 0 ? declared : { ...DEFAULT_ENVIRONMENTS };
}

/** Overrides in environment `envName` that name an entry the base manifest does not declare. */
export function overrideIssues(manifest: AppManifest, envName: string, environment: EnvironmentSpec): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const overrides: unknown = environment.overrides;
  if (overrides === undefined) return issues;
  if (!isRecord(overrides)) return [manifestIssue('invalid-value', `environments.${envName}.overrides`, { detail: 'Expected an object.' })];
  for (const section of OVERRIDABLE) {
    const entries = overrides[section];
    if (entries === undefined) continue;
    const path = `environments.${envName}.overrides.${section}`;
    if (!isRecord(entries)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an object keyed by id.' }));
      continue;
    }
    const base: unknown = manifest[section];
    for (const id of Object.keys(entries)) {
      if (!isRecord(base) || !hasOwnKey(base, id)) issues.push(manifestIssue('unknown-override-entry', path, { value: id }));
    }
  }
  return issues;
}

export interface EnvironmentResolution {
  /** The manifest with the environment's overrides applied; null for an unknown environment. */
  manifest: AppManifest | null;
  environment: ResolvedEnvironment | null;
  issues: ManifestIssue[];
}

/** `envName`'s environment and the manifest as it runs there. */
export function resolveEnvironment(manifest: AppManifest, envName: string): EnvironmentResolution {
  const environments = environmentsOf(manifest);
  const environment = Object.prototype.hasOwnProperty.call(environments, envName) ? environments[envName] : undefined;
  if (!isRecord(environment)) {
    return { manifest: null, environment: null, issues: [manifestIssue('unknown-environment', 'environments', { value: envName, detail: `Known: ${Object.keys(environments).join(', ')}.` })] };
  }
  const issues = overrideIssues(manifest, envName, environment);
  const overrides: Record<string, unknown> = isRecord(environment.overrides) ? environment.overrides : {};
  const resolved: AppManifest = { ...manifest };
  for (const section of OVERRIDABLE) {
    const base: unknown = manifest[section];
    const patch = overrides[section];
    if (!isRecord(base) || !isRecord(patch)) continue;
    const merged: Record<string, unknown> = mergeDeep(base, {});
    // Only entries the base declares itself; the rest are `unknown-override-entry` issues.
    for (const [id, value] of Object.entries(patch)) if (hasOwnKey(base, id)) merged[id] = mergeDeep(base[id], value);
    (resolved as unknown as Record<string, unknown>)[section] = merged;
  }
  return { manifest: resolved, environment: { ...environment, name: envName }, issues };
}
