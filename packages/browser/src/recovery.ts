/**
 * `@seanhogg/builderforce-webcontainers/recovery` — suspend → recover (W12 phase 2):
 * the runtime lease with its fencing token, and the recovery coordinator with its
 * participants (VFS, database, services). Kept off the package root so preview-only
 * consumers never load it.
 */
export { claimRuntimeLease, indexedDbLeaseTokenStore, lockName, LOCK_PREFIX, DatabaseCoordinationError } from './shared/runtimeLease.js';
export type { ClaimedRuntimeLease, LeaseState, LeaseTokenStore, LockManagerLike, RuntimeLease, RuntimeLeaseRecord } from './shared/runtimeLease.js';
export { capabilityParticipants, createEnvironmentRecovery, RECOVERY_STAGES, RecoveryCheckpointError, RecoveryLeaseError } from './recovery/environmentRecovery.js';
export type { Durability, EnvironmentRecovery, EnvironmentRecoveryOptions, RecoveryParticipant, RecoveryResult, RecoveryStage } from './recovery/environmentRecovery.js';
export { createRecoveryStore, identityRedact, loadRecord, RECOVERY_STORE_ENTRIES, RecoveryStorageError, saveRecord } from './recovery/persistedRecord.js';
export type { Persisted, PersistedRecord, Redact } from './recovery/persistedRecord.js';
export { createVfsParticipant } from './recovery/vfsParticipant.js';
export type { VfsParticipantOptions } from './recovery/vfsParticipant.js';
export { createDatabaseParticipant } from './recovery/databaseParticipant.js';
export type { DatabaseParticipantOptions } from './recovery/databaseParticipant.js';
export { createServiceParticipant } from './recovery/serviceParticipant.js';
export type { ApplicationStarter, ServiceParticipantOptions } from './recovery/serviceParticipant.js';
