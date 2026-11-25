/**
 * The app manifest, v1: `builderforce.json` with `"version": 1`. One file
 * declares the whole application — services, resources (databases, caches,
 * queues, storage, mail, …), scheduled jobs, ingress and environments — and
 * `toApplicationSpec` turns one environment of it into the `ApplicationSpec`
 * the application runtime runs. Every entry is keyed by id, so ids cannot
 * repeat and environment overrides merge per key. Pure data: no browser APIs.
 */

/** The canonical `$schema` URL of a v1 manifest. */
export const APP_MANIFEST_SCHEMA_URL = 'https://builderforce.ai/schema/app.v1.json';

/** Where an environment runs. `browser` is this runtime (temporary); the rest are durable infrastructure. */
export type ManifestTargetId = 'browser' | 'cloudflare' | 'aws' | 'azure' | 'gcp';

export const MANIFEST_TARGETS: readonly ManifestTargetId[] = ['browser', 'cloudflare', 'aws', 'azure', 'gcp'];

/** Every environment is one or the other. `debug` is allowed only on `non-production`. */
export type EnvironmentTier = 'production' | 'non-production';

export const ENVIRONMENT_TIERS: readonly EnvironmentTier[] = ['production', 'non-production'];

/** `session`: runs while the session that started it lives. `always-on`: needs a durable target. */
export type Availability = 'session' | 'always-on';

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface PostgresResource {
  type: 'postgres';
  /** Data outlives the application. Default false. */
  persistent?: boolean;
  /** Postgres extensions, e.g. `vector`. */
  extensions?: string[];
  /** Database name. Default: the provider's. */
  name?: string;
}

export interface RedisResource {
  type: 'redis';
  persistent?: boolean;
  maxMemoryMb?: number;
}

/** `redis`: a queue on a `redis` resource named by `on`. `native`: the target's own queue service. */
export type QueueEngine = 'redis' | 'native';

export interface QueueResource {
  type: 'queue';
  engine: QueueEngine;
  /** The `redis` resource the queue lives on (engine `redis`). */
  on?: string;
}

export interface ObjectStorageResource {
  type: 'object-storage';
}

export interface MailResource {
  type: 'mail';
}

export type GraphEngine = 'neo4j' | 'memgraph' | 'age';

export interface GraphResource {
  type: 'graph';
  engine: GraphEngine;
}

/** A Connected Account (Stripe, Slack, …) by id; its credentials reach the runtime from the vault, never the file. */
export interface ConnectionResource {
  type: 'connection';
  connection: string;
}

/**
 * The platform's AI gateway, host-delivered: a service that `uses` it gets
 * `AI_BASE_URL` (an OpenAI-compatible base ending `/v1`) and never a key — the
 * host attaches the signed-in session and forwards to the API gateway host.
 */
export interface AiResource {
  type: 'ai';
  /** Allowlist. Absent: the platform router picks. A request whose model is outside the list is rejected at the host relay, not forwarded. */
  models?: string[];
}

/** An OpenTofu / Terraform / Bicep / CloudFormation module only a customer-cloud target applies. */
export interface ExternalResource {
  type: 'external';
  module: string;
  /** Module outputs that become environment variables. */
  outputs?: string[];
}

export type ResourceSpec =
  | PostgresResource
  | RedisResource
  | QueueResource
  | ObjectStorageResource
  | MailResource
  | GraphResource
  | ConnectionResource
  | AiResource
  | ExternalResource;

export type ResourceType = ResourceSpec['type'];

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** When a service is ready. Exactly one of the kind keys, plus an optional `timeout` duration (`30s`). */
export type ManifestReadiness = (
  /** `GET <path>` answers 2xx or 3xx. */
  | { http: string }
  /** The port opens. */
  | { port: true }
  /** The database accepts a query. */
  | { query: true }
  /** The process exits with code 0. */
  | { exitZero: true }
  /** The process started (a worker with no port). */
  | { started: true }
) & { timeout?: string };

export type ManifestRestart = 'never' | 'on-failure' | 'always';

export type ScaleMetric = 'concurrency' | 'cpu' | 'requests';

export interface ScaleSpec {
  min?: number;
  max?: number;
  metric?: ScaleMetric;
}

export interface ManifestService {
  /** The runtime provider that starts it: `node`, `python`, `php`, `dotnet`, `rust`. */
  runtime: string;
  /** Project-relative directory. Default `/`. */
  root?: string;
  /**
   * A command line, not just a program name: `npm run dev`, `uvicorn main:app --port 8000`,
   * `"/path with space/node" server.js`. Its words become the program and leading arguments
   * (before `args`). A line that needs a shell (`&&`, `|`, redirects, `FOO=1 cmd`, `$VAR`)
   * runs through `bfsh -c` for a node service on the browser target, takes no `args`, and is
   * an issue on any other runtime or target. Use forward slashes in paths: an unquoted `\` escapes.
   */
  command: string;
  /** Arguments after the command line's own. */
  args?: string[];
  port?: number;
  /** Default `backend`. A `frontend` never receives credentials. */
  role?: 'frontend' | 'backend';
  /** Resource ids this service connects to. */
  uses?: string[];
  /** Service ids that must be ready first. */
  dependsOn?: string[];
  readiness?: ManifestReadiness;
  restart?: ManifestRestart;
  /** Wins over everything the runtime injects. */
  env?: Record<string, string>;
  availability?: Availability;
  scale?: ScaleSpec;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Run a command in a service's environment. */
export interface JobRun {
  service: string;
  /** A command line (`npm run migrate`), read like a service's `command`. */
  command: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Call one of a service's HTTP endpoints. Default method `POST`. */
export interface JobInvoke {
  service: string;
  method?: HttpMethod;
  path: string;
}

/** `allow`: runs may overlap. `forbid`: skip a fire while one runs. `replace`: stop the running one. */
export type JobConcurrency = 'allow' | 'forbid' | 'replace';

/** What a fire missed while nothing was running does: `skip` it, or `run-once` on wake. */
export type MissedPolicy = 'skip' | 'run-once';

interface JobBase {
  /** Five-field cron, e.g. `0 3 * * *`. */
  schedule: string;
  /** IANA time zone. Default `UTC`. */
  timezone?: string;
  concurrency?: JobConcurrency;
  /** Duration, e.g. `10m`. */
  timeout?: string;
  missed?: MissedPolicy;
  availability?: Availability;
}

export type JobSpec = JobBase & ({ run: JobRun; invoke?: never } | { invoke: JobInvoke; run?: never });

// ---------------------------------------------------------------------------
// Agents (the `agents` capability)
// ---------------------------------------------------------------------------

/** What starts an agent run: by hand, on a five-field cron (same reader as `jobs`), or on a service event. */
export type AgentTrigger = { manual: true } | { cron: string; timezone?: string } | { service: string; event: string };

/** Spend limits of one agent run. Each a positive number. */
export interface AgentBudget {
  tokens?: number;
  usd?: number;
  steps?: number;
}

/** An autonomous agent, declared by role. */
export interface AgentDeclaration {
  /** A role or workload key the host's router resolves; never a model id. Exactly one. */
  role?: string;
  workload?: string;
  /** Project-relative path to the agent's instructions. */
  instructions?: string;
  skills?: string[];
  /** Tool catalog keys (`env.fs.read`, …); catalog membership is checked by the host at start. */
  tools?: string[];
  /** Memory namespace, id-shaped. */
  memory?: string;
  /** Default: `[{ manual: true }]`. */
  triggers?: AgentTrigger[];
  budget?: AgentBudget;
}

/** `capabilities.agents`: the environment's ceilings. A declaration above one is `policy-widening`. */
export interface AgentsPolicy {
  maxAgents?: number;
  maxDepth?: number;
  maxChildren?: number;
  tools?: string[];
  budget?: AgentBudget;
}

/** `capabilities.state`: how each kind of environment state persists. An absent key takes its default (`STATE_POLICY_DEFAULTS`). */
export interface StatePolicy {
  source?: 'journal' | 'snapshot';
  transcripts?: 'durable' | 'none';
  checkpoints?: 'durable' | 'none';
  tempFiles?: 'ephemeral' | 'durable';
}

// ---------------------------------------------------------------------------
// Ingress and environments
// ---------------------------------------------------------------------------

export interface IngressRoute {
  path: string;
  service: string;
}

export interface IngressSpec {
  routes: IngressRoute[];
}

/** Every key optional, all the way down; arrays are values (replaced, never concatenated). */
export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** Per-key changes an environment makes to the base manifest. */
export interface ManifestOverrides {
  services?: Record<string, DeepPartial<ManifestService>>;
  resources?: Record<string, DeepPartial<ResourceSpec>>;
  jobs?: Record<string, DeepPartial<JobSpec>>;
}

export interface EnvironmentSpec {
  target: ManifestTargetId;
  /** The Connected Account (cloud credentials) a durable target deploys with. */
  connection?: string;
  tier: EnvironmentTier;
  /** Non-production only; on production it is a validation error. */
  debug?: boolean;
  overrides?: ManifestOverrides;
}

/** An environment by name, as `resolveEnvironment` hands it out. */
export interface ResolvedEnvironment extends EnvironmentSpec {
  name: string;
}

export interface AppManifest {
  $schema?: string;
  version: 1;
  name?: string;
  resources?: Record<string, ResourceSpec>;
  services?: Record<string, ManifestService>;
  jobs?: Record<string, JobSpec>;
  ingress?: IngressSpec;
  environments?: Record<string, EnvironmentSpec>;
  /**
   * Project-relative overrides for logs, diagnostics, and methodology.
   * An empty or absolute path, a `..` segment, or a key other than these three is an
   * `invalid-path` / `invalid-value` warning, and `parseManifest` omits it.
   * Defaults, when an override is absent or invalid: `.builderforce/methodology`,
   * `.builderforce/logs`, `.builderforce/diagnostics`.
   */
  paths?: import('./paths.js').ManifestPaths;
  /** Enabled capabilities by id, each with its config (`{ agents?: AgentsPolicy }`, `{ state?: StatePolicy }` for the built-in entries). */
  capabilities?: Record<string, unknown>;
  /** Autonomous agents by id; needs `capabilities.agents`. */
  agents?: Record<string, AgentDeclaration>;
}

/** The environments a manifest that declares none has. */
export const DEFAULT_ENVIRONMENTS: Readonly<Record<string, EnvironmentSpec>> = {
  local: { target: 'browser', tier: 'non-production' },
};
