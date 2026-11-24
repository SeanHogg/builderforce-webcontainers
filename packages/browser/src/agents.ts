/**
 * `@seanhogg/builderforce-webcontainers/agents` — the Agent Environment (W12 phases 3 and 6):
 * the `env.*` tool port, the `agents` capability hooks and child runtimes. Re-exports the
 * pure contracts from core. Kept off the package root so preview-only consumers never load it.
 */
export { ENV_TOOL_KEYS, ENV_TOOL_MUTATES, ENV_TOOL_PREFIX, PERSISTED_FORMAT_VERSION, idempotencyKeyString, isEnvToolKey } from '@seanhogg/builderforce-webcontainers-core';
export type { AgentHostEvent, AgentHostPort, AgentRunState, EnvCorrelation, EnvToolKey, EnvToolRefusal, IdempotencyKey } from '@seanhogg/builderforce-webcontainers-core';
export {
  createEnvironmentToolPort,
  ENV_FETCH_METHODS,
  ENV_FS_WRITE_LIMIT_BYTES,
  ENV_OUTPUT_LIMIT_BYTES,
  ENV_RUN_DEFAULT_TIMEOUT_MS,
} from './agents/environmentToolPort.js';
export type { EnvironmentAgent, EnvironmentToolPort, EnvironmentToolPortDeps, EnvToolResult } from './agents/environmentToolPort.js';
export { createAgentsCapability, createAgentsCapabilityHooks, parseAgentsCheckpoint } from './agents/agentsCapability.js';
export type { AgentsCapabilityCheckpoint, AgentsCapabilityDeps } from './agents/agentsCapability.js';
export { childRuntimeKeys, ChildHierarchyStorageError, createChildRuntimes, indexedDbChildHierarchyStore, memoryChildHierarchyStore, parseChildHierarchyRecord } from './agents/childRuntimes.js';
export type {
  ChildBoot,
  ChildFailed,
  ChildFailure,
  ChildFailurePhase,
  ChildHierarchyIssue,
  ChildHierarchyIssueCode,
  ChildHierarchyRecord,
  ChildHierarchyStore,
  ChildOwnedElsewhere,
  ChildRefused,
  ChildRuntime,
  ChildRuntimeContext,
  ChildRuntimeEvent,
  ChildRuntimeHandle,
  ChildRuntimeKeys,
  ChildRuntimes,
  ChildRuntimesDeps,
  ChildRuntimeState,
  Rediscovered,
} from './agents/childRuntimes.js';
