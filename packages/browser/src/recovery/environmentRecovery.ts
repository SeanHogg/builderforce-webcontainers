/**
 * Suspend → recover (W12 phase 2): the coordinator that checkpoints an
 * environment's state and brings it back in a new tab after the old one was
 * killed without a stop.
 *
 * State is held by participants, one per kind (the VFS, each database, the
 * services, each capability such as `agents`), and each owns its own records:
 * nothing reaches into another's state. They run by stage — the files first,
 * then resources (databases), then services, then capabilities — and within a
 * stage after the participants they depend on. A participant that fails gives a
 * typed `failed` result and the later stages still run, so one lost database
 * does not keep the rest of the environment down.
 *
 * Only the lease owner runs: a tab whose lease is held elsewhere is refused, and
 * the fencing token taken at the start is checked before every participant, so
 * a holder that lost the lease meanwhile stops before writing anything else. An
 * `ephemeral` environment persists nothing and recovers nothing (every
 * participant `skipped`).
 */
import { orderByDependencies } from '@seanhogg/builderforce-webcontainers-core';
import type { AppManifest } from '@seanhogg/builderforce-webcontainers-core/manifest';
import { messageOf } from '../app/asyncHelpers.js';
import type { RuntimeLease } from '../shared/runtimeLease.js';

export const RECOVERY_STAGES = ['vfs', 'resources', 'services', 'capabilities'] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

export type RecoveryResult = { id: string; status: 'restored' | 'fresh' | 'skipped' | 'failed'; detail?: string };

/** One kind of state an environment recovers. Capabilities (`agents`) register through this interface. */
export interface RecoveryParticipant {
  id: string;
  stage: RecoveryStage;
  /** Participants of this stage or an earlier one that must run first. */
  dependsOn?: string[];
  /** Persist the current state. Throws when it could not. */
  checkpoint(): Promise<void>;
  /** Restore from what the last checkpoint persisted: `fresh` when there was nothing. */
  recover(): Promise<RecoveryResult>;
}

/** `ephemeral`: nothing outlives the tab. `local`: checkpoints are kept in this browser. */
export type Durability = 'ephemeral' | 'local';

export interface EnvironmentRecoveryOptions {
  participants: RecoveryParticipant[];
  durability: Durability;
  lease: RuntimeLease;
}

export interface EnvironmentRecovery {
  /** Checkpoint every participant; rejects with `RecoveryCheckpointError` naming those that failed. */
  checkpoint(): Promise<void>;
  /** Recover every participant, in order; one result each. */
  recover(): Promise<RecoveryResult[]>;
}

/** This tab does not own the environment's lease (or lost it while running). */
export class RecoveryLeaseError extends Error {
  constructor() {
    super('This tab does not own the environment: another tab holds its lease, or took it over.');
    this.name = 'RecoveryLeaseError';
  }
}

/** Participants whose checkpoint failed; the others were checkpointed. */
export class RecoveryCheckpointError extends Error {
  constructor(readonly failures: RecoveryResult[]) {
    super(`Checkpoint failed for ${failures.map((failure) => `${failure.id} (${failure.detail})`).join(', ')}.`);
    this.name = 'RecoveryCheckpointError';
  }
}

/** `participants` by stage, then by dependency. Throws for a duplicate id, an unknown or later-stage dependency, or a cycle. */
function orderParticipants(participants: readonly RecoveryParticipant[]): RecoveryParticipant[] {
  const byId = new Map<string, RecoveryParticipant>();
  for (const participant of participants) {
    if (byId.has(participant.id)) throw new Error(`Recovery participant "${participant.id}" is registered twice.`);
    byId.set(participant.id, participant);
  }
  const rank = (participant: RecoveryParticipant) => RECOVERY_STAGES.indexOf(participant.stage);
  for (const participant of participants) {
    for (const dependency of participant.dependsOn ?? []) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`Recovery participant "${participant.id}" depends on "${dependency}", which is not registered.`);
      if (rank(target) > rank(participant)) throw new Error(`Recovery participant "${participant.id}" (${participant.stage}) depends on "${dependency}" of the later stage ${target.stage}.`);
    }
  }
  return RECOVERY_STAGES.flatMap((stage) => {
    const ids = participants.filter((participant) => participant.stage === stage).map((participant) => participant.id);
    // Dependencies of an earlier stage are not in `ids`: unknown here, so ignored (their stage already ran).
    const ordered = orderByDependencies(ids, (id) => (ids.includes(id) ? (byId.get(id)!.dependsOn ?? []) : undefined));
    if (!ordered.ok) throw new Error(`Recovery participants depend on each other in a cycle: ${ordered.cycle.join(' → ')}.`);
    return ordered.order.map((id) => byId.get(id)!);
  });
}

export function createEnvironmentRecovery(options: EnvironmentRecoveryOptions): EnvironmentRecovery {
  const ordered = orderParticipants(options.participants);
  const { lease } = options;
  const ephemeral = options.durability === 'ephemeral';

  /** The fencing token this run holds; throws unless this tab owns the lease. */
  const fence = (): number => {
    const state = lease.state;
    if (state.kind !== 'owner') throw new RecoveryLeaseError();
    return state.fencingToken;
  };
  const assertStillOwner = (token: number) => {
    if (!lease.assertFence(token)) throw new RecoveryLeaseError();
  };

  return {
    async checkpoint() {
      const token = fence();
      if (ephemeral) return;
      const failures: RecoveryResult[] = [];
      for (const participant of ordered) {
        assertStillOwner(token);
        try {
          await participant.checkpoint();
        } catch (error) {
          failures.push({ id: participant.id, status: 'failed', detail: messageOf(error) });
        }
      }
      if (failures.length) throw new RecoveryCheckpointError(failures);
    },
    async recover() {
      const token = fence();
      if (ephemeral) return ordered.map((participant): RecoveryResult => ({ id: participant.id, status: 'skipped' }));
      const results: RecoveryResult[] = [];
      for (const participant of ordered) {
        assertStillOwner(token);
        try {
          results.push({ ...(await participant.recover()), id: participant.id });
        } catch (error) {
          results.push({ id: participant.id, status: 'failed', detail: messageOf(error) });
        }
      }
      return results;
    },
  };
}

/**
 * The `capabilities` participants for a manifest: one per enabled capability
 * (`manifest.capabilities`) that has a factory, so a manifest without `agents`
 * records no agents participant. Factories come from the packages that
 * implement the capabilities.
 */
export function capabilityParticipants(manifest: Pick<AppManifest, 'capabilities'>, factories: Readonly<Record<string, () => RecoveryParticipant>>): RecoveryParticipant[] {
  return Object.keys(manifest.capabilities ?? {}).flatMap((id) => {
    const factory = Object.hasOwn(factories, id) ? factories[id] : undefined;
    if (!factory) return [];
    const participant = factory();
    if (participant.stage !== 'capabilities') throw new Error(`The recovery participant for capability "${id}" must run at stage capabilities, not ${participant.stage}.`);
    return [participant];
  });
}
