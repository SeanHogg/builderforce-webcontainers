/**
 * `@seanhogg/builderforce-webcontainers-core/app` — the pure half of the
 * application runtime: the `ApplicationSpec`, its validation, the service graph,
 * the lifecycle state machine, per-service environment, restart policy and the
 * `RuntimeProvider` port. The browser package's `./app` subpath runs it.
 */
export { readinessOf, restartPolicyOf, roleOf } from './spec.js';
export type { ApplicationSpec, DatabaseSpec, ReadinessKind, ReadinessSpec, RestartPolicy, ServiceRole, ServiceSpec, ServiceType } from './spec.js';
export { validateSpec, assertValidSpec, describeIssue, ApplicationSpecError } from './validateSpec.js';
export type { SpecIssue, SpecIssueCode } from './validateSpec.js';
export { serviceGraph } from './serviceGraph.js';
export type { ServiceGraph } from './serviceGraph.js';
export { createLifecycle, canTransition, IllegalTransitionError, SERVICE_TRANSITIONS, ACTIVE_STATES } from './lifecycle.js';
export type { ServiceLifecycle, ServiceState, StateChange } from './lifecycle.js';
export { serviceEnv, serviceMap, databaseUrl, databaseName, envName, receivesDatabaseCredentials, mayConnectToDatabase, withoutDatabaseCredentials, CREDENTIAL_POLICY, DATABASE_URL_SCHEMES, DATABASE_PROVIDER_DEFAULTS } from './serviceEnv.js';
export type { DatabaseCredential, ServiceEnvOptions } from './serviceEnv.js';
export { ServiceGraphPolicy } from './servicePortPolicy.js';
export { restartDecision, DEFAULT_RESTART_LIMITS } from './restartPolicy.js';
export type { RestartDecision, RestartLimits } from './restartPolicy.js';
export { createProviderRegistry, acceptApplication } from './runtimeProvider.js';
export type { Acceptance, DatabaseControl, DeclinedService, ProviderRegistry, ProviderResolution, RuntimeProvider, ServiceHandle, ServiceStartContext } from './runtimeProvider.js';
