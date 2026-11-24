/**
 * The browser runtime's hooks for the built-in `agents` capability (W12 phase
 * 3). Core defines the capability (`AGENTS_CAPABILITY`) without hooks; the host
 * registers `createAgentsCapability(deps)` — `{ ...AGENTS_CAPABILITY, load }` —
 * so core never imports the browser. The hooks drive the host's agent runs
 * through its `AgentHostPort`: deactivating cancels every run still going, a
 * checkpoint records them (stamped with the persisted format version) and a
 * recover hands a checkpoint's runs back to the host to resume.
 */
import { AGENTS_CAPABILITY, PERSISTED_FORMAT_VERSION, type AgentHostPort, type CapabilityDefinition, type CapabilityHooks } from '@seanhogg/builderforce-webcontainers-core';

/** What a checkpoint of the `agents` capability holds. */
export interface AgentsCapabilityCheckpoint {
  readonly formatVersion: typeof PERSISTED_FORMAT_VERSION;
  readonly runIds: readonly string[];
}

export interface AgentsCapabilityDeps {
  host: Pick<AgentHostPort, 'cancel'>;
  /** The runs still going (the host's run registry). */
  activeRuns(): readonly string[];
  /** Resume the runs a checkpoint recorded (the host re-attaches them through its run store). */
  resumeRuns(runIds: readonly string[]): Promise<void>;
}

/** A checkpoint this runtime wrote, or a typed error: a foreign or newer format is never guessed at. */
export function parseAgentsCheckpoint(state: unknown): AgentsCapabilityCheckpoint {
  if (typeof state !== 'object' || state === null) throw new TypeError('The agents checkpoint is not an object.');
  const { formatVersion, runIds } = state as Record<string, unknown>;
  if (formatVersion !== PERSISTED_FORMAT_VERSION) throw new TypeError(`The agents checkpoint has format version ${String(formatVersion)}; this runtime reads ${PERSISTED_FORMAT_VERSION}.`);
  if (!Array.isArray(runIds) || runIds.some((id) => typeof id !== 'string' || id === '')) throw new TypeError('The agents checkpoint "runIds" must be a list of run ids.');
  return { formatVersion, runIds: runIds as string[] };
}

export function createAgentsCapabilityHooks(deps: AgentsCapabilityDeps): CapabilityHooks {
  return {
    async deactivate() {
      // Every run is cancelled even when one cancel fails; the failures are then raised together.
      const results = await Promise.allSettled(deps.activeRuns().map((runId) => deps.host.cancel(runId)));
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, `Cancelling ${failures.length} agent run(s) failed.`);
    },
    async checkpoint(): Promise<AgentsCapabilityCheckpoint> {
      return { formatVersion: PERSISTED_FORMAT_VERSION, runIds: [...deps.activeRuns()] };
    },
    async recover(state) {
      await deps.resumeRuns(parseAgentsCheckpoint(state).runIds);
    },
  };
}

/** `AGENTS_CAPABILITY` with its browser hooks, for the host's capability registry. */
export function createAgentsCapability(deps: AgentsCapabilityDeps): CapabilityDefinition {
  return { ...AGENTS_CAPABILITY, load: async () => createAgentsCapabilityHooks(deps) };
}
