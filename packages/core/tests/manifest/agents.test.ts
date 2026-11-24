import { describe, expect, it } from 'vitest';
import { createCapabilityRegistry, describeManifestIssue, parseManifest, validateManifest, type AppManifest, type CapabilityDefinition, type ManifestIssue, type ValidateManifestOptions } from '../../src/manifest/index.js';
import { agentsManifest } from './agentFixtures.js';

/** Validate `agentsManifest()` changed by `edit`. */
function issuesAfter(edit: (manifest: Record<string, any>) => void, options?: ValidateManifestOptions): ManifestIssue[] {
  const manifest = agentsManifest() as unknown as Record<string, any>;
  edit(manifest);
  return validateManifest(manifest as unknown as AppManifest, options);
}

const find = (issues: ManifestIssue[], code: ManifestIssue['code']) => issues.filter((issue) => issue.code === code);
const def = (id: string, dependsOn: string[] = []): CapabilityDefinition => ({ id, version: 1, dependsOn, requires: [], configSchema: {} });
/** Enables only `ids`, with no agents. */
const enableOnly = (...ids: string[]) => (m: Record<string, any>) => {
  m.capabilities = Object.fromEntries(ids.map((id) => [id, {}]));
  delete m.agents;
};

describe('capabilities and agents', () => {
  it('parses the agents fixture with no issues', () => {
    expect(parseManifest(JSON.stringify(agentsManifest())).issues).toEqual([]);
  });

  it('refuses a capability the environment does not register', () => {
    expect(find(issuesAfter((m) => (m.capabilities.voice = {})), 'unknown-capability')).toMatchObject([{ path: 'capabilities.voice', value: 'voice', severity: 'error' }]);
  });

  it('reports a missing dependency and a dependency cycle', () => {
    const child = createCapabilityRegistry([def('agents'), def('child', ['agents'])]);
    expect(find(issuesAfter(enableOnly('child'), { capabilities: child }), 'capability-missing-dependency')).toMatchObject([{ path: 'capabilities.child', value: 'agents' }]);
    const loop = createCapabilityRegistry([def('a', ['b']), def('b', ['a'])]);
    expect(find(issuesAfter(enableOnly('a', 'b'), { capabilities: loop }), 'capability-dependency-cycle')).toMatchObject([{ path: 'capabilities', detail: 'a → b → a' }]);
  });

  it('refuses a declaration above a ceiling, never clamping it', () => {
    expect(find(issuesAfter((m) => m.agents.developer.tools.push('env.preview.fetch')), 'policy-widening')).toMatchObject([{ path: 'agents.developer.tools', value: 'env.preview.fetch' }]);
    expect(find(issuesAfter((m) => (m.agents.developer.budget.tokens = 300000)), 'policy-widening')).toMatchObject([{ path: 'agents.developer.budget.tokens', value: 'budget.tokens' }]);
    expect(find(issuesAfter((m) => (m.agents.reviewer = { role: 'reviewer' })), 'policy-widening')).toMatchObject([{ path: 'agents', value: 'maxAgents' }]);
  });

  it('refuses a model id where a role belongs', () => {
    expect(find(issuesAfter((m) => (m.agents.coordinator.model = 'gpt-4o')), 'agent-model-id')).toMatchObject([{ path: 'agents.coordinator.model', value: 'model' }]);
    expect(find(issuesAfter((m) => (m.agents.coordinator.role = 'anthropic/claude')), 'agent-model-id')).toMatchObject([{ path: 'agents.coordinator.role', value: 'anthropic/claude' }]);
    expect(find(issuesAfter((m) => delete m.agents.coordinator.role), 'missing-field')).toMatchObject([{ path: 'agents.coordinator', value: 'role' }]);
  });

  it('needs capabilities.agents when agents are declared', () => {
    expect(find(issuesAfter((m) => delete m.capabilities), 'capability-not-enabled')).toMatchObject([{ path: 'agents', value: 'agents' }]);
  });

  it('checks triggers with the cron reader and against the services', () => {
    expect(find(issuesAfter((m) => (m.agents.developer.triggers = [{ cron: 'every night' }])), 'invalid-schedule')).toMatchObject([{ path: 'agents.developer.triggers.0.cron' }]);
    expect(find(issuesAfter((m) => (m.agents.tester.triggers = [{ service: 'nope', event: 'deployed' }])), 'unknown-service')).toMatchObject([{ path: 'agents.tester.triggers.0.service', value: 'nope' }]);
    expect(find(issuesAfter((m) => (m.agents.tester.triggers = [{ manual: true, cron: '0 3 * * *' }])), 'invalid-value')).toMatchObject([{ path: 'agents.tester.triggers.0' }]);
    expect(find(issuesAfter((m) => (m.agents.tester.triggers = 'manual')), 'invalid-value')).toMatchObject([{ path: 'agents.tester.triggers' }]);
  });

  it('refuses instructions outside the project as an error', () => {
    const [issue] = find(issuesAfter((m) => (m.agents.developer.instructions = '../x.md')), 'invalid-path');
    expect(issue).toMatchObject({ path: 'agents.developer.instructions', severity: 'error', value: '../x.md' });
    expect(describeManifestIssue(issue!)).not.toContain('default');
  });

  it('warns when an environment target lacks what a capability requires', () => {
    const issues = issuesAfter((m) => (m.environments.staging = { target: 'cloudflare', tier: 'non-production' }));
    expect(find(issues, 'capability-unsupported-target')).toMatchObject([{ path: 'environments.staging', value: 'agents', severity: 'warning' }]);
  });

  it('adds nothing to a manifest without capabilities or agents', () => {
    expect(issuesAfter(enableOnly())).toEqual([]);
  });
});
