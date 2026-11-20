/**
 * The capability matrix as data: which resource types (and jobs) each target
 * can host, with which provider, or why not. The browser run, the browser
 * acceptance check and every `DeploymentTarget` read this one table, so nothing
 * derives a capability twice. A new resource type or target is one entry here.
 * A local stand-in must speak the real protocol; a type without one is declined.
 */
import type { ManifestTargetId, ResourceType } from './types.js';

export interface TargetCapability {
  readonly supported: boolean;
  /** Who hosts it when supported: `pglite`, `neon`, `r2`, … */
  readonly provider?: string;
  /** Why not, when unsupported: one sentence a person can read. */
  readonly reason?: string;
}

type CapabilityRow = Readonly<Record<ManifestTargetId, TargetCapability>>;

const LATER = (what: string): TargetCapability => ({ supported: false, reason: `${what} in the browser arrives in a later release.` });
const yes = (provider: string): TargetCapability => ({ supported: true, provider });
const no = (reason: string): TargetCapability => ({ supported: false, reason });

const CLOUD_ONLY_MODULES = 'Infrastructure modules are applied only by a customer-cloud target (AWS, Azure, GCP).';

export const RESOURCE_CAPABILITIES: Readonly<Record<ResourceType, CapabilityRow>> = {
  postgres: { browser: yes('pglite'), cloudflare: yes('neon'), aws: yes('rds'), azure: yes('azure-postgres'), gcp: yes('cloud-sql') },
  redis: { browser: LATER('Redis'), cloudflare: yes('upstash'), aws: yes('elasticache'), azure: yes('azure-cache'), gcp: yes('memorystore') },
  queue: { browser: LATER('A queue'), cloudflare: yes('cloudflare-queues'), aws: yes('sqs'), azure: yes('service-bus'), gcp: yes('pubsub') },
  'object-storage': { browser: LATER('Object storage'), cloudflare: yes('r2'), aws: yes('s3'), azure: yes('blob-storage'), gcp: yes('gcs') },
  mail: { browser: LATER('The mail catcher'), cloudflare: yes('connection'), aws: yes('connection'), azure: yes('connection'), gcp: yes('connection') },
  graph: {
    browser: no('A graph database (Neo4j, Memgraph) has no browser stand-in that speaks its protocol.'),
    cloudflare: no('Cloudflare hosts no graph database.'),
    aws: yes('connection'),
    azure: yes('connection'),
    gcp: yes('connection'),
  },
  connection: { browser: yes('vault'), cloudflare: yes('vault'), aws: yes('vault'), azure: yes('vault'), gcp: yes('vault') },
  external: { browser: no(CLOUD_ONLY_MODULES), cloudflare: no(CLOUD_ONLY_MODULES), aws: yes('opentofu'), azure: yes('opentofu'), gcp: yes('opentofu') },
};

/** Scheduled jobs per target. */
export const JOB_CAPABILITIES: CapabilityRow = {
  browser: { supported: false, reason: 'Scheduled jobs arrive in a later release.' },
  cloudflare: yes('cron-triggers'),
  aws: yes('eventbridge'),
  azure: yes('container-apps-jobs'),
  gcp: yes('cloud-scheduler'),
};

/** Every resource type the manifest knows. */
export const RESOURCE_TYPES = Object.keys(RESOURCE_CAPABILITIES) as ResourceType[];

export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RESOURCE_CAPABILITIES, value);
}

/** The capability of `target` for a resource `type`; unsupported with a reason for an unknown type or target. */
export function resourceCapability(type: string, target: string): TargetCapability {
  const row = isResourceType(type) ? RESOURCE_CAPABILITIES[type] : undefined;
  if (!row) return no(`"${type}" is not a known resource type.`);
  return (row as Record<string, TargetCapability | undefined>)[target] ?? no(`"${target}" is not a known target.`);
}

/** Whether `target` can host a resource of `type`. */
export function targetSupports(type: string, target: string): boolean {
  return resourceCapability(type, target).supported;
}
