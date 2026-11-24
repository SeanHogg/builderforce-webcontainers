/**
 * The `runtime.agents.*` tools (W12 phase 3): every handler resolves an agent's
 * tools as the ONE catalog ∩ its allowlist and fails closed — an undeclared
 * agent, a tool outside the resolved set and a run this host did not start are
 * typed refusals that never reach the host port.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeclaration } from '@seanhogg/builderforce-webcontainers-core/manifest';
import {
  createAgentsCapabilityHooks,
  createRuntimeAgents,
  RUNTIME_AGENTS_CANCEL,
  RUNTIME_AGENTS_LIST,
  RUNTIME_AGENTS_START,
  RUNTIME_AGENTS_STATUS,
  RUNTIME_AGENTS_STEER,
  type RuntimeAgentsDeps,
} from '../../src/agents.js';

const CATALOG_SEARCH = 'web.search';
const CATALOG_DEPLOY = 'deploy.release';
/** On the developer's allowlist, but in no catalog. */
const NOT_IN_CATALOG = 'secrets.read';
const ENVIRONMENT = { environmentId: 'env-1', runtimeId: 'rt-1' };

const AGENTS: Record<string, AgentDeclaration> = {
  developer: { role: 'developer', tools: ['env.fs.read', 'env.fs.write', CATALOG_SEARCH, NOT_IN_CATALOG] },
  tester: { workload: 'tester', tools: ['env.run'] },
  silent: { role: 'observer' },
};

function setup(overrides: Partial<RuntimeAgentsDeps> = {}) {
  let next = 0;
  const host = {
    start: vi.fn(async (_agentId: string, _input: Parameters<RuntimeAgentsDeps['host']['start']>[1]) => ({ runId: `run-${++next}` })),
    steer: vi.fn(async (_runId: string, _message: string) => {}),
    cancel: vi.fn(async (_runId: string) => {}),
  };
  const agents = createRuntimeAgents({ host, agents: () => AGENTS, catalog: () => [CATALOG_SEARCH, CATALOG_DEPLOY], correlation: ENVIRONMENT, ...overrides });
  return { host, agents };
}

describe('runtime.agents', () => {
  it('lists each declared agent with the catalog ∩ its allowlist, hiding catalog tools it does not name and allowlist entries in no catalog', async () => {
    const { agents } = setup();
    expect(await agents.call(RUNTIME_AGENTS_LIST)).toEqual({
      ok: true,
      result: [
        { id: 'developer', role: 'developer', tools: ['env.fs.read', 'env.fs.write', CATALOG_SEARCH] },
        { id: 'tester', role: 'tester', tools: ['env.run'] },
        { id: 'silent', role: 'observer', tools: [] },
      ],
    });
  });

  it('starts a declared agent through the host, correlated with the environment, and tracks the run with its resolved tools', async () => {
    const { host, agents } = setup();
    const started = await agents.call(RUNTIME_AGENTS_START, { agentId: 'developer', task: 'Fix the failing test.' });
    expect(started).toEqual({ ok: true, result: { runId: 'run-1', agentId: 'developer', tools: ['env.fs.read', 'env.fs.write', CATALOG_SEARCH] } });
    expect(host.start).toHaveBeenCalledWith('developer', { task: 'Fix the failing test.', correlation: { ...ENVIRONMENT, agentId: 'developer' } });
    expect(await agents.call(RUNTIME_AGENTS_STATUS, { runId: 'run-1' })).toMatchObject({ ok: true, result: { runId: 'run-1', agentId: 'developer' } });
    expect(agents.activeRuns()).toEqual(['run-1']);
  });

  it('steers and cancels a run it started; a cancelled run is no longer active', async () => {
    const { host, agents } = setup();
    await agents.call(RUNTIME_AGENTS_START, { agentId: 'tester', task: 'Run the suite.' });
    expect(await agents.call(RUNTIME_AGENTS_STEER, { runId: 'run-1', message: 'Only the unit tests.' })).toEqual({ ok: true, result: { runId: 'run-1', steered: true } });
    expect(host.steer).toHaveBeenCalledWith('run-1', 'Only the unit tests.');
    expect(await agents.call(RUNTIME_AGENTS_CANCEL, { runId: 'run-1' })).toEqual({ ok: true, result: { runId: 'run-1', cancelled: true } });
    expect(host.cancel).toHaveBeenCalledWith('run-1');
    expect(agents.activeRuns()).toEqual([]);
  });

  it.each(['reviewer', 'constructor', '__proto__'])('refuses to start an undeclared agent id (%s), before the host is asked', async (agentId) => {
    const { host, agents } = setup();
    expect(await agents.call(RUNTIME_AGENTS_START, { agentId, task: 'Review.' })).toMatchObject({ ok: false, refusal: { code: 'agent-not-declared' } });
    expect(agents.authorize(agentId, 'env.fs.read')).toMatchObject({ ok: false, refusal: { code: 'agent-not-declared' } });
    expect(host.start).not.toHaveBeenCalled();
  });

  it('authorizes a tool in the catalog ∩ the allowlist', () => {
    const { agents } = setup();
    expect(agents.authorize('developer', CATALOG_SEARCH)).toEqual({ ok: true, result: CATALOG_SEARCH });
    expect(agents.authorize('developer', 'env.fs.write')).toEqual({ ok: true, result: 'env.fs.write' });
  });

  it.each([
    ['a catalog tool outside the allowlist', CATALOG_DEPLOY],
    ['an environment tool outside the allowlist', 'env.run'],
    ['an allowlist entry in no catalog', NOT_IN_CATALOG],
  ])('refuses %s', (_label, tool) => {
    const { agents } = setup();
    expect(agents.authorize('developer', tool)).toMatchObject({ ok: false, refusal: { code: 'tool-not-allowed' } });
  });

  it('grants nothing to an agent that declares no allowlist', () => {
    const { agents } = setup();
    expect(agents.authorize('silent', CATALOG_SEARCH)).toMatchObject({ ok: false, refusal: { code: 'tool-not-allowed' } });
  });

  it('reads the catalog at call time: a tool removed from it is refused and no longer listed', async () => {
    let catalog = [CATALOG_SEARCH];
    const { agents } = setup({ catalog: () => catalog });
    expect(agents.authorize('developer', CATALOG_SEARCH)).toMatchObject({ ok: true });
    catalog = [];
    expect(agents.authorize('developer', CATALOG_SEARCH)).toMatchObject({ ok: false, refusal: { code: 'tool-not-allowed' } });
    expect(await agents.call(RUNTIME_AGENTS_LIST)).toMatchObject({ ok: true, result: expect.arrayContaining([{ id: 'developer', role: 'developer', tools: ['env.fs.read', 'env.fs.write'] }]) });
  });

  it('refuses a run this host did not start, and a run whose agent is no longer declared', async () => {
    let declared: Record<string, AgentDeclaration> = AGENTS;
    const { host, agents } = setup({ agents: () => declared });
    expect(await agents.call(RUNTIME_AGENTS_STEER, { runId: 'run-9', message: 'Go.' })).toMatchObject({ ok: false, refusal: { code: 'run-not-found' } });
    expect(await agents.call(RUNTIME_AGENTS_CANCEL, { runId: 'run-9' })).toMatchObject({ ok: false, refusal: { code: 'run-not-found' } });
    await agents.call(RUNTIME_AGENTS_START, { agentId: 'tester', task: 'Run the suite.' });
    declared = {};
    expect(await agents.call(RUNTIME_AGENTS_STEER, { runId: 'run-1', message: 'Go.' })).toMatchObject({ ok: false, refusal: { code: 'agent-not-declared' } });
    expect(host.steer).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown tool', 'runtime.agents.delete', {}, 'unknown-tool'],
    ['arguments that are not an object', RUNTIME_AGENTS_START, 'developer', 'invalid-argument'],
    ['a blank task', RUNTIME_AGENTS_START, { agentId: 'developer', task: '  ' }, 'invalid-argument'],
    ['a missing run id', RUNTIME_AGENTS_STATUS, {}, 'invalid-argument'],
  ])('refuses %s with a typed refusal', async (_label, tool, args, code) => {
    const { host, agents } = setup();
    expect(await agents.call(tool as typeof RUNTIME_AGENTS_START, args)).toMatchObject({ ok: false, refusal: { code } });
    expect(host.start).not.toHaveBeenCalled();
  });

  it('raises a failure of the host port instead of reporting it as a refusal, and tracks no run', async () => {
    const { agents } = setup({ host: { start: async () => Promise.reject(new Error('host gone')), steer: async () => {}, cancel: async () => {} } });
    await expect(agents.call(RUNTIME_AGENTS_START, { agentId: 'developer', task: 'Fix it.' })).rejects.toThrow('host gone');
    expect(agents.activeRuns()).toEqual([]);
  });

  it('backs the agents capability: its active runs are the ones the capability checkpoints and cancels', async () => {
    const { host, agents } = setup();
    await agents.call(RUNTIME_AGENTS_START, { agentId: 'developer', task: 'A.' });
    await agents.call(RUNTIME_AGENTS_START, { agentId: 'tester', task: 'B.' });
    const hooks = createAgentsCapabilityHooks({ host, activeRuns: agents.activeRuns, resumeRuns: async () => {} });
    expect(await hooks.checkpoint!()).toMatchObject({ runIds: ['run-1', 'run-2'] });
    await hooks.deactivate!();
    expect(host.cancel.mock.calls.map(([runId]) => runId)).toEqual(['run-1', 'run-2']);
  });
});
