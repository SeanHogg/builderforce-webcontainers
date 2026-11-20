/**
 * `@seanhogg/builderforce-webcontainers-core/manifest` — the app manifest v1
 * (`builderforce.json`): its types, the one parser, validation with typed
 * issues, the JSON Schema, environments and their overrides, tier variables and
 * the diagnostics gate, cron, the capability matrix, and the mapping of one
 * environment to an `ApplicationSpec`. Pure: no browser or Node APIs.
 */
export { APP_MANIFEST_SCHEMA_URL, DEFAULT_ENVIRONMENTS, ENVIRONMENT_TIERS, HTTP_METHODS, MANIFEST_TARGETS } from './types.js';
export type {
  AppManifest,
  Availability,
  ConnectionResource,
  DeepPartial,
  EnvironmentSpec,
  EnvironmentTier,
  ExternalResource,
  GraphEngine,
  GraphResource,
  HttpMethod,
  IngressRoute,
  IngressSpec,
  JobConcurrency,
  JobInvoke,
  JobRun,
  JobSpec,
  MailResource,
  ManifestOverrides,
  ManifestReadiness,
  ManifestRestart,
  ManifestService,
  ManifestTargetId,
  MissedPolicy,
  ObjectStorageResource,
  PostgresResource,
  QueueEngine,
  QueueResource,
  RedisResource,
  ResolvedEnvironment,
  ResourceSpec,
  ResourceType,
  ScaleMetric,
  ScaleSpec,
} from './types.js';
export { describeManifestIssue, hasErrors as manifestHasErrors } from './issues.js';
export type { ManifestIssue, ManifestIssueCode, ManifestIssueSeverity } from './issues.js';
export { parseManifest } from './parse.js';
export type { ManifestParseResult } from './parse.js';
export { validateManifest } from './validate.js';
export { parseCron, nextFire, isValidTimeZone } from './cron.js';
export type { CronParseResult, CronSchedule } from './cron.js';
export { parseDuration } from './duration.js';
export { RESOURCE_CAPABILITIES, JOB_CAPABILITIES, RESOURCE_TYPES, isResourceType, resourceCapability, targetSupports } from './capabilities.js';
export type { TargetCapability } from './capabilities.js';
export { tierEnv, tierMode, diagnosticsLevel, TIER_ENV_CONVENTIONS } from './tierEnv.js';
export type { DiagnosticsLevel, TierContext, TierMode, TierVariable } from './tierEnv.js';
export { resolveEnvironment, mergeDeep as mergeOverrides, environmentsOf } from './overrides.js';
export type { EnvironmentResolution } from './overrides.js';
export { toApplicationSpec, toReadinessSpec } from './toApplicationSpec.js';
export type { DeclinedResource, ManifestSpecResult, ToApplicationSpecOptions } from './toApplicationSpec.js';
export { APP_MANIFEST_SCHEMA_V1 } from './schema.js';
