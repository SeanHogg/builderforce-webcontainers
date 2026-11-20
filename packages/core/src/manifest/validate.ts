/**
 * `validateManifest`: every issue in a v1 manifest, typed and located by path.
 * The input is read from a file, so nothing about its shape is trusted: a
 * section that is not an object is an issue, never a crash. What only the
 * produced `ApplicationSpec` can tell (readiness that needs a port, dependency
 * cycles) is left to `validateSpec`, which `toApplicationSpec` runs.
 */
import { SERVICE_ID } from '../app/validateSpec.js';
import { isResourceType } from './capabilities.js';
import { isValidTimeZone, parseCron } from './cron.js';
import { parseDuration } from './duration.js';
import { manifestIssue, type ManifestIssue } from './issues.js';
import { environmentsOf, hasOwnKey, isRecord, isSafeKey, overrideIssues } from './overrides.js';
import { ENVIRONMENT_TIERS, HTTP_METHODS, MANIFEST_TARGETS, type AppManifest } from './types.js';

const READINESS_KINDS = ['http', 'port', 'query', 'exitZero', 'started'] as const;
const QUEUE_ENGINES = ['redis', 'native'];
const GRAPH_ENGINES = ['neo4j', 'memgraph', 'age'];
const ROLES = ['frontend', 'backend'];
const RESTARTS = ['never', 'on-failure', 'always'];
const AVAILABILITIES = ['session', 'always-on'];
const SCALE_METRICS = ['concurrency', 'cpu', 'requests'];
const CONCURRENCIES = ['allow', 'forbid', 'replace'];
const MISSED = ['skip', 'run-once'];

type Issues = ManifestIssue[];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A record section, or an issue when it is present but not an object. */
function section(value: unknown, path: string, issues: Issues): Record<string, unknown> {
  if (value === undefined) return {};
  if (isRecord(value)) return value;
  issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an object keyed by id.' }));
  return {};
}

function checkEnum(value: unknown, allowed: readonly string[], path: string, issues: Issues): void {
  if (value !== undefined && !(typeof value === 'string' && allowed.includes(value))) {
    issues.push(manifestIssue('invalid-value', path, { value: String(value), detail: `Use one of: ${allowed.join(', ')}.` }));
  }
}

function checkType(value: unknown, type: 'string' | 'boolean' | 'number', path: string, issues: Issues): void {
  if (value !== undefined && typeof value !== type) issues.push(manifestIssue('invalid-value', path, { value: String(value), detail: `Expected a ${type}.` }));
}

function stringArray(value: unknown, path: string, issues: Issues): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a list of strings.' }));
  return [];
}

/** The field's value, or undefined (and a `missing-field` issue) when it is absent or empty. */
function required(entry: Record<string, unknown>, field: string, path: string, issues: Issues): unknown {
  const value = entry[field];
  if (value !== undefined && value !== null && value !== '') return value;
  issues.push(manifestIssue('missing-field', path, { value: field }));
  return undefined;
}

function checkDuration(value: unknown, path: string, issues: Issues): void {
  if (value !== undefined && (typeof value !== 'string' || parseDuration(value) === undefined)) issues.push(manifestIssue('invalid-duration', path, { value: String(value) }));
}

function checkIds(entries: Record<string, unknown>, sectionName: string, issues: Issues): void {
  // A prototype key (`constructor`, `prototype`) is never an id: no manifest walker copies one.
  for (const id of Object.keys(entries)) if (!SERVICE_ID.test(id) || !isSafeKey(id)) issues.push(manifestIssue('invalid-id', `${sectionName}.${id}`, { value: id }));
}

function validateResources(resources: Record<string, unknown>, issues: Issues): void {
  for (const [id, entry] of Object.entries(resources)) {
    const path = `resources.${id}`;
    if (!isRecord(entry)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a resource object.' }));
      continue;
    }
    const type = required(entry, 'type', path, issues);
    if (type === undefined) continue;
    if (!isResourceType(type)) {
      issues.push(manifestIssue('unknown-resource-type', `${path}.type`, { value: String(type) }));
      continue;
    }
    if (type === 'postgres' || type === 'redis') checkType(entry.persistent, 'boolean', `${path}.persistent`, issues);
    switch (type) {
      case 'postgres':
        stringArray(entry.extensions, `${path}.extensions`, issues);
        checkType(entry.name, 'string', `${path}.name`, issues);
        break;
      case 'redis':
        if (entry.maxMemoryMb !== undefined && !(typeof entry.maxMemoryMb === 'number' && entry.maxMemoryMb > 0)) issues.push(manifestIssue('invalid-value', `${path}.maxMemoryMb`, { value: String(entry.maxMemoryMb), detail: 'Expected a positive number.' }));
        break;
      case 'queue': {
        const engine = required(entry, 'engine', path, issues);
        checkEnum(engine, QUEUE_ENGINES, `${path}.engine`, issues);
        if (engine === 'redis') {
          const host = typeof entry.on === 'string' ? resources[entry.on] : undefined;
          if (!isRecord(host) || host.type !== 'redis') issues.push(manifestIssue('invalid-queue-host', `${path}.on`, { value: entry.on === undefined ? undefined : String(entry.on) }));
        }
        break;
      }
      case 'graph':
        checkEnum(required(entry, 'engine', path, issues), GRAPH_ENGINES, `${path}.engine`, issues);
        break;
      case 'connection':
        if (!isNonEmptyString(entry.connection)) issues.push(manifestIssue('missing-field', path, { value: 'connection' }));
        break;
      case 'external':
        if (!isNonEmptyString(entry.module)) issues.push(manifestIssue('missing-field', path, { value: 'module' }));
        stringArray(entry.outputs, `${path}.outputs`, issues);
        break;
      default:
        break;
    }
  }
}

function validateReadiness(readiness: unknown, path: string, issues: Issues): void {
  if (readiness === undefined) return;
  if (!isRecord(readiness)) {
    issues.push(manifestIssue('invalid-readiness', path));
    return;
  }
  const kinds = READINESS_KINDS.filter((kind) => readiness[kind] !== undefined);
  if (kinds.length !== 1) {
    issues.push(manifestIssue('invalid-readiness', path, { detail: kinds.length > 1 ? `It names ${kinds.join(' and ')}.` : undefined }));
  } else if (kinds[0] === 'http' ? !(typeof readiness.http === 'string' && readiness.http.startsWith('/')) : readiness[kinds[0]!] !== true) {
    issues.push(manifestIssue('invalid-readiness', `${path}.${kinds[0]}`, { detail: kinds[0] === 'http' ? 'An http check names a path starting with "/".' : 'Set it to true.' }));
  }
  checkDuration(readiness.timeout, `${path}.timeout`, issues);
}

function validateServices(services: Record<string, unknown>, resources: Record<string, unknown>, issues: Issues): void {
  const portOwners = new Map<number, string[]>();
  for (const [id, entry] of Object.entries(services)) {
    const path = `services.${id}`;
    if (!isRecord(entry)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a service object.' }));
      continue;
    }
    if (hasOwnKey(resources, id)) issues.push(manifestIssue('duplicate-id', path, { value: id }));
    if (!isNonEmptyString(entry.runtime)) issues.push(manifestIssue('missing-field', path, { value: 'runtime' }));
    if (!isNonEmptyString(entry.command)) issues.push(manifestIssue('missing-field', path, { value: 'command' }));
    checkType(entry.root, 'string', `${path}.root`, issues);
    stringArray(entry.args, `${path}.args`, issues);
    if (entry.port !== undefined) {
      const port = entry.port;
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) issues.push(manifestIssue('invalid-port', `${path}.port`, { value: String(port) }));
      else portOwners.set(port, [...(portOwners.get(port) ?? []), id]);
    }
    checkEnum(entry.role, ROLES, `${path}.role`, issues);
    for (const use of stringArray(entry.uses, `${path}.uses`, issues)) {
      if (!hasOwnKey(resources, use)) issues.push(manifestIssue('unknown-resource', `${path}.uses`, { value: use }));
      else if (entry.role === 'frontend') issues.push(manifestIssue('frontend-uses-credentials', `${path}.uses`, { value: use, severity: 'warning' }));
    }
    for (const dependency of stringArray(entry.dependsOn, `${path}.dependsOn`, issues)) {
      if (!hasOwnKey(services, dependency)) issues.push(manifestIssue('unknown-service', `${path}.dependsOn`, { value: dependency }));
    }
    validateReadiness(entry.readiness, `${path}.readiness`, issues);
    checkEnum(entry.restart, RESTARTS, `${path}.restart`, issues);
    if (entry.env !== undefined && !(isRecord(entry.env) && Object.values(entry.env).every((value) => typeof value === 'string'))) {
      issues.push(manifestIssue('invalid-value', `${path}.env`, { detail: 'Expected an object of string values.' }));
    }
    checkEnum(entry.availability, AVAILABILITIES, `${path}.availability`, issues);
    validateScale(entry.scale, `${path}.scale`, issues);
  }
  for (const [port, owners] of portOwners) {
    if (owners.length > 1) issues.push(manifestIssue('duplicate-port', 'services', { value: String(port), detail: `Claimed by ${owners.join(', ')}.` }));
  }
}

function validateScale(scale: unknown, path: string, issues: Issues): void {
  if (scale === undefined) return;
  if (!isRecord(scale)) {
    issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an object.' }));
    return;
  }
  const count = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
  if (!count(scale.min) || !count(scale.max)) issues.push(manifestIssue('invalid-value', path, { detail: 'min and max are whole numbers of instances.' }));
  else if (typeof scale.min === 'number' && typeof scale.max === 'number' && scale.min > scale.max) issues.push(manifestIssue('invalid-value', path, { detail: 'min is above max.' }));
  checkEnum(scale.metric, SCALE_METRICS, `${path}.metric`, issues);
}

function validateJobs(jobs: Record<string, unknown>, services: Record<string, unknown>, issues: Issues): void {
  for (const [id, entry] of Object.entries(jobs)) {
    const path = `jobs.${id}`;
    if (!isRecord(entry)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a job object.' }));
      continue;
    }
    const schedule = required(entry, 'schedule', path, issues);
    if (schedule !== undefined) {
      const parsed = typeof schedule === 'string' ? parseCron(schedule) : { ok: false as const, reason: 'Expected a string.' };
      if (!parsed.ok) issues.push(manifestIssue('invalid-schedule', `${path}.schedule`, { value: String(schedule), detail: parsed.reason }));
    }
    if (entry.timezone !== undefined && !(typeof entry.timezone === 'string' && isValidTimeZone(entry.timezone))) issues.push(manifestIssue('invalid-timezone', `${path}.timezone`, { value: String(entry.timezone) }));
    if (entry.run !== undefined && entry.invoke !== undefined) issues.push(manifestIssue('invalid-value', path, { detail: 'A job either runs a command or invokes an endpoint, not both.' }));
    else if (entry.run === undefined && entry.invoke === undefined) issues.push(manifestIssue('missing-field', path, { value: 'run' }));
    const action = entry.run ?? entry.invoke;
    const actionPath = `${path}.${entry.run !== undefined ? 'run' : 'invoke'}`;
    if (action !== undefined && !isRecord(action)) issues.push(manifestIssue('invalid-value', actionPath, { detail: 'Expected an object.' }));
    else if (isRecord(action)) {
      const serviceId = required(action, 'service', actionPath, issues);
      const service = typeof serviceId === 'string' ? services[serviceId] : undefined;
      if (serviceId !== undefined && service === undefined) issues.push(manifestIssue('unknown-service', `${actionPath}.service`, { value: String(serviceId) }));
      if (entry.run !== undefined) {
        if (!isNonEmptyString(action.command)) issues.push(manifestIssue('missing-field', actionPath, { value: 'command' }));
      } else {
        if (!(typeof action.path === 'string' && action.path.startsWith('/'))) issues.push(manifestIssue('invalid-value', `${actionPath}.path`, { value: action.path === undefined ? undefined : String(action.path), detail: 'An endpoint path starts with "/".' }));
        checkEnum(action.method, HTTP_METHODS, `${actionPath}.method`, issues);
        if (isRecord(service) && service.port === undefined) issues.push(manifestIssue('invoke-without-port', actionPath, { value: String(serviceId) }));
      }
    }
    checkEnum(entry.concurrency, CONCURRENCIES, `${path}.concurrency`, issues);
    checkDuration(entry.timeout, `${path}.timeout`, issues);
    checkEnum(entry.missed, MISSED, `${path}.missed`, issues);
    checkEnum(entry.availability, AVAILABILITIES, `${path}.availability`, issues);
  }
}

function validateIngress(ingress: unknown, services: Record<string, unknown>, issues: Issues): void {
  if (ingress === undefined) return;
  const routes = isRecord(ingress) ? ingress.routes : undefined;
  if (!Array.isArray(routes)) {
    issues.push(manifestIssue('invalid-value', 'ingress', { detail: 'Expected { "routes": [...] }.' }));
    return;
  }
  routes.forEach((route: unknown, index) => {
    const path = `ingress.routes.${index}`;
    if (!isRecord(route) || !(typeof route.path === 'string' && route.path.startsWith('/'))) issues.push(manifestIssue('invalid-value', path, { detail: 'A route has a path starting with "/" and a service.' }));
    else if (typeof route.service !== 'string' || !hasOwnKey(services, route.service)) issues.push(manifestIssue('unknown-service', `${path}.service`, { value: String(route.service) }));
  });
}

function validateEnvironments(manifest: AppManifest, issues: Issues): void {
  section(manifest.environments, 'environments', issues);
  for (const [name, entry] of Object.entries(environmentsOf(manifest))) {
    const path = `environments.${name}`;
    if (!isRecord(entry)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an environment object.' }));
      continue;
    }
    const target = required(entry, 'target', path, issues);
    if (target !== undefined && !(MANIFEST_TARGETS as readonly unknown[]).includes(target)) issues.push(manifestIssue('unknown-target', `${path}.target`, { value: String(target) }));
    const tier = required(entry, 'tier', path, issues);
    if (tier !== undefined && !(ENVIRONMENT_TIERS as readonly unknown[]).includes(tier)) issues.push(manifestIssue('invalid-tier', `${path}.tier`, { value: String(tier) }));
    checkType(entry.debug, 'boolean', `${path}.debug`, issues);
    checkType(entry.connection, 'string', `${path}.connection`, issues);
    if (tier === 'production' && entry.debug === true) issues.push(manifestIssue('debug-in-production', `${path}.debug`, { value: name }));
    issues.push(...overrideIssues(manifest, name, entry as never));
  }
}

/** Every issue in the manifest; empty when it is valid. */
export function validateManifest(manifest: AppManifest): ManifestIssue[] {
  const issues: Issues = [];
  const raw = manifest as unknown as Record<string, unknown>;
  if (raw.version !== 1) issues.push(manifestIssue('unsupported-version', 'version', { value: String(raw.version) }));
  checkType(raw.name, 'string', 'name', issues);
  checkType(raw.$schema, 'string', '$schema', issues);
  const resources = section(raw.resources, 'resources', issues);
  const services = section(raw.services, 'services', issues);
  const jobs = section(raw.jobs, 'jobs', issues);
  checkIds(resources, 'resources', issues);
  checkIds(services, 'services', issues);
  checkIds(jobs, 'jobs', issues);
  validateResources(resources, issues);
  validateServices(services, resources, issues);
  validateJobs(jobs, services, issues);
  validateIngress(raw.ingress, services, issues);
  validateEnvironments(manifest, issues);
  return issues;
}
