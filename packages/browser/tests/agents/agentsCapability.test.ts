/**
 * The `agents` capability's browser hooks (W12 phase 3): deactivating cancels
 * every run still going and raises the failures together, a checkpoint records
 * the runs stamped with the persisted format version, and a recover hands only
 * a checkpoint this runtime wrote back to the host.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENTS_CAPABILITY, PERSISTED_FORMAT_VERSION } from '@seanhogg/builderforce-webcontainers-core';
import { createAgentsCapability, createAgentsCapabilityHooks, parseAgentsCheckpoint, type AgentsCapabilityDeps } from '../../src/agents.js';

function setup(runIds: string[], cancel: AgentsCapabilityDeps['host']['cancel'] = async () => {}) {
  const deps = {
    host: { cancel: vi.fn(cancel) },
    activeRuns: () => runIds,
    resumeRuns: vi.fn(async (_runIds: readonly string[]) => {}),
  };
  return { deps, hooks: createAgentsCapabilityHooks(deps) };
}

describe('agents capability hooks', () => {
  it('is the core definition with a browser load', async () => {
    const { deps } = setup([]);
    const capability = createAgentsCapability(deps);
    expect(capability).toMatchObject({ id: AGENTS_CAPABILITY.id, version: AGENTS_CAPABILITY.version });
    expect(await capability.load?.()).toMatchObject({ deactivate: expect.any(Function), checkpoint: expect.any(Function), recover: expect.any(Function) });
  });

  it('cancels every run on deactivate, even when one cancel fails, then raises the failures together', async () => {
    const { deps, hooks } = setup(['run-1', 'run-2', 'run-3'], async (runId) => {
      if (runId === 'run-2') throw new Error('host gone');
    });
    const failure = await hooks.deactivate!().catch((error: unknown) => error);
    expect(deps.host.cancel.mock.calls.map(([runId]) => runId)).toEqual(['run-1', 'run-2', 'run-3']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(['host gone']);
  });

  it('checkpoints the active runs, stamped with the persisted format version, and recovers them', async () => {
    const { deps, hooks } = setup(['run-1', 'run-2']);
    const state = await hooks.checkpoint!();
    expect(state).toEqual({ formatVersion: PERSISTED_FORMAT_VERSION, runIds: ['run-1', 'run-2'] });
    await hooks.recover!(state);
    expect(deps.resumeRuns).toHaveBeenCalledWith(['run-1', 'run-2']);
  });

  it.each([
    ['not an object', null],
    ['a foreign format version', { formatVersion: PERSISTED_FORMAT_VERSION + 1, runIds: ['run-1'] }],
    ['an empty run id', { formatVersion: PERSISTED_FORMAT_VERSION, runIds: [''] }],
    ['a run id that is not a string', { formatVersion: PERSISTED_FORMAT_VERSION, runIds: [7] }],
  ])('refuses to recover %s, and resumes nothing', async (_label, state) => {
    const { deps, hooks } = setup([]);
    expect(() => parseAgentsCheckpoint(state)).toThrow(TypeError);
    await expect(hooks.recover!(state)).rejects.toThrow(TypeError);
    expect(deps.resumeRuns).not.toHaveBeenCalled();
  });
});
