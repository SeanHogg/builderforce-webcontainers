/**
 * Check an `ApplicationSpec` before anything starts: every issue is a typed
 * value (`SpecIssue`), so a host can show each one next to the service it is
 * about. `assertValidSpec` throws them together as one `ApplicationSpecError`.
 */
import { envName } from './serviceEnv.js';
import { readinessOf, type ApplicationSpec, type ReadinessKind } from './spec.js';

/** Starts with a letter, so `<ID>_URL` is a valid environment variable name. */
const SERVICE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export type SpecIssue =
  | { code: 'missing-project-id' }
  | { code: 'invalid-id'; serviceId: string }
  | { code: 'duplicate-service'; serviceId: string }
  | { code: 'env-name-collision'; envName: string; serviceIds: string[] }
  | { code: 'missing-runtime'; serviceId: string }
  | { code: 'unknown-dependency'; serviceId: string; dependency: string }
  | { code: 'dependency-cycle'; cycle: string[] }
  | { code: 'invalid-port'; serviceId: string; port: number }
  | { code: 'duplicate-port'; port: number; serviceIds: string[] }
  | { code: 'missing-port'; serviceId: string; readiness: ReadinessKind }
  | { code: 'invalid-timeout'; serviceId: string; timeoutMs: number }
  | { code: 'missing-health-path'; serviceId: string }
  | { code: 'missing-command'; serviceId: string }
  | { code: 'missing-database'; serviceId: string };

export type SpecIssueCode = SpecIssue['code'];

/** One line a person can read. */
export function describeIssue(issue: SpecIssue): string {
  switch (issue.code) {
    case 'missing-project-id':
      return 'The application has no project id.';
    case 'invalid-id':
      return `Service id "${issue.serviceId}" must start with a letter and contain only letters, digits, "_" and "-".`;
    case 'duplicate-service':
      return `Service id "${issue.serviceId}" is used more than once.`;
    case 'env-name-collision':
      return `Services ${issue.serviceIds.join(', ')} would share the environment name ${issue.envName}_URL.`;
    case 'missing-runtime':
      return `Service "${issue.serviceId}" names no runtime.`;
    case 'unknown-dependency':
      return `Service "${issue.serviceId}" depends on "${issue.dependency}", which is not a service of this application.`;
    case 'dependency-cycle':
      return `Services depend on each other in a cycle: ${issue.cycle.join(' -> ')} -> ${issue.cycle[0]}.`;
    case 'invalid-port':
      return `Service "${issue.serviceId}" has port ${issue.port}; a port is a whole number from 1 to 65535.`;
    case 'duplicate-port':
      return `Port ${issue.port} is claimed by more than one service: ${issue.serviceIds.join(', ')}.`;
    case 'missing-port':
      return `Service "${issue.serviceId}" uses "${issue.readiness}" readiness but has no port.`;
    case 'invalid-timeout':
      return `Service "${issue.serviceId}" has readiness timeout ${issue.timeoutMs}; a timeout is a positive number of milliseconds.`;
    case 'missing-health-path':
      return `Service "${issue.serviceId}" uses "http" readiness without a path.`;
    case 'missing-command':
      return `Service "${issue.serviceId}" has no command to run.`;
    case 'missing-database':
      return `Database service "${issue.serviceId}" has no database settings (engine, provider, persistent).`;
  }
}

export class ApplicationSpecError extends Error {
  constructor(readonly issues: SpecIssue[]) {
    super(`Invalid application spec:\n${issues.map((issue) => `- ${describeIssue(issue)}`).join('\n')}`);
    this.name = 'ApplicationSpecError';
  }
}

/** Every issue in the spec; empty when it is valid. */
export function validateSpec(spec: ApplicationSpec): SpecIssue[] {
  const issues: SpecIssue[] = [];
  if (!spec.projectId?.trim()) issues.push({ code: 'missing-project-id' });
  const ids = new Set<string>();
  const portOwners = new Map<number, string[]>();
  const envOwners = new Map<string, string[]>();

  for (const service of spec.services) {
    if (!SERVICE_ID.test(service.id)) issues.push({ code: 'invalid-id', serviceId: service.id });
    if (ids.has(service.id)) issues.push({ code: 'duplicate-service', serviceId: service.id });
    else envOwners.set(envName(service.id), [...(envOwners.get(envName(service.id)) ?? []), service.id]);
    ids.add(service.id);
    if (!service.runtime?.trim()) issues.push({ code: 'missing-runtime', serviceId: service.id });

    if (service.port !== undefined) {
      if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) issues.push({ code: 'invalid-port', serviceId: service.id, port: service.port });
      else portOwners.set(service.port, [...(portOwners.get(service.port) ?? []), service.id]);
    }
    const readiness = readinessOf(service);
    if ((readiness.kind === 'port' || readiness.kind === 'http') && service.port === undefined) issues.push({ code: 'missing-port', serviceId: service.id, readiness: readiness.kind });
    if (readiness.kind === 'http' && !readiness.path?.trim()) issues.push({ code: 'missing-health-path', serviceId: service.id });
    if (readiness.timeoutMs !== undefined && !(Number.isFinite(readiness.timeoutMs) && readiness.timeoutMs > 0)) issues.push({ code: 'invalid-timeout', serviceId: service.id, timeoutMs: readiness.timeoutMs });
    if (service.type !== 'database' && !service.command) issues.push({ code: 'missing-command', serviceId: service.id });
    if (service.type === 'database' && !service.database) issues.push({ code: 'missing-database', serviceId: service.id });
  }

  for (const [name, serviceIds] of envOwners) {
    if (serviceIds.length > 1) issues.push({ code: 'env-name-collision', envName: name, serviceIds });
  }
  for (const [port, serviceIds] of portOwners) {
    if (serviceIds.length > 1) issues.push({ code: 'duplicate-port', port, serviceIds });
  }
  for (const service of spec.services) {
    for (const dependency of service.dependsOn ?? []) {
      if (!ids.has(dependency)) issues.push({ code: 'unknown-dependency', serviceId: service.id, dependency });
    }
  }
  for (const cycle of findCycles(spec)) issues.push({ code: 'dependency-cycle', cycle });
  return issues;
}

/** Throws `ApplicationSpecError` listing every issue; returns the spec when it is valid. */
export function assertValidSpec(spec: ApplicationSpec): ApplicationSpec {
  const issues = validateSpec(spec);
  if (issues.length > 0) throw new ApplicationSpecError(issues);
  return spec;
}

/**
 * Dependency cycles, each rotated to start at its earliest service in spec
 * order. Not every elementary cycle: a depth-first search reports at least one
 * cycle for every group of services that depend on each other in a loop —
 * enough to say the spec is invalid and where. Unknown dependencies are ignored here.
 */
function findCycles(spec: ApplicationSpec): string[][] {
  const edges = new Map(spec.services.map((service) => [service.id, service.dependsOn ?? []]));
  const order = new Map(spec.services.map((service, index) => [service.id, index]));
  const done = new Set<string>();
  const onPath: string[] = [];
  const seen = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    if (done.has(id)) return;
    const at = onPath.indexOf(id);
    if (at >= 0) {
      const cycle = onPath.slice(at);
      const first = cycle.reduce((best, item, index) => ((order.get(item) ?? 0) < (order.get(cycle[best]!) ?? 0) ? index : best), 0);
      const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
      const key = rotated.join('\u0000');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(rotated);
      }
      return;
    }
    onPath.push(id);
    for (const dependency of edges.get(id) ?? []) if (edges.has(dependency)) visit(dependency);
    onPath.pop();
    done.add(id);
  };
  for (const service of spec.services) visit(service.id);
  return cycles;
}
