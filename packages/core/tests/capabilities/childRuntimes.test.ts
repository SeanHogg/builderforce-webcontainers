import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES, CHILD_RUNTIMES_CAPABILITY, narrowChildPolicy, validateManifest, type AgentsPolicy } from '../../src/manifest/index.js';
import { agentsManifest } from '../manifest/agentFixtures.js';

const parent: AgentsPolicy = { maxAgents: 3, maxDepth: 2, maxChildren: 2, tools: ['env.fs.read', 'env.fs.write', 'env.run'], budget: { tokens: 1000, usd: 5 } };

describe('the child-runtimes capability', () => {
  it('is built in, depends on agents and takes an empty config', () => {
    expect(BUILTIN_CAPABILITIES.get('child-runtimes')).toBe(CHILD_RUNTIMES_CAPABILITY);
    expect(CHILD_RUNTIMES_CAPABILITY.dependsOn).toEqual(['agents']);
    expect(CHILD_RUNTIMES_CAPABILITY.validateConfig?.({})).toEqual([]);
    expect(CHILD_RUNTIMES_CAPABILITY.validateConfig?.({ maxDepth: 1 })).toMatchObject([{ path: 'maxDepth' }]);
    expect(CHILD_RUNTIMES_CAPABILITY.validateConfig?.(true)).toMatchObject([{ path: '' }]);
  });

  it('is refused in a manifest without agents', () => {
    const manifest = agentsManifest();
    manifest.capabilities = { 'child-runtimes': {} };
    delete manifest.agents;
    expect(validateManifest(manifest).filter((issue) => issue.code === 'capability-missing-dependency')).toMatchObject([{ path: 'capabilities.child-runtimes', value: 'agents' }]);
  });
});

describe('narrowChildPolicy', () => {
  it('inherits the parent one level down when the fragment names nothing', () => {
    expect(narrowChildPolicy(parent, undefined)).toEqual({ policy: { ...parent, maxDepth: 1 }, issues: [] });
  });

  it('accepts a stricter child', () => {
    const narrowed = narrowChildPolicy(parent, { tools: ['env.fs.read'], budget: { tokens: 500 }, maxChildren: 0, maxDepth: 0 });
    expect(narrowed.issues).toEqual([]);
    expect(narrowed.policy).toEqual({ maxAgents: 3, maxChildren: 0, maxDepth: 0, tools: ['env.fs.read'], budget: { tokens: 500, usd: 5 } });
  });

  it('allows values equal to each ceiling (a child at exactly the deepest allowed level)', () => {
    const narrowed = narrowChildPolicy(parent, { tools: parent.tools, budget: parent.budget, maxAgents: 3, maxChildren: 2, maxDepth: 1 });
    expect(narrowed.issues).toEqual([]);
    expect(narrowNested(narrowed.policy!)).toMatchObject({ policy: { maxDepth: 0 } });
  });

  it('refuses a child below a parent with maxDepth 0, so depth M + 1 is refused', () => {
    const leaf = narrowNested(narrowNested(parent).policy!).policy!;
    expect(leaf.maxDepth).toBe(0);
    expect(narrowChildPolicy(leaf, {})).toMatchObject({ issues: [{ code: 'policy-widening', value: 'maxDepth', severity: 'error' }] });
  });

  it('refuses each widening with a typed issue, never clamping', () => {
    const narrowed = narrowChildPolicy(parent, { tools: ['env.fs.read', 'env.preview.fetch'], budget: { tokens: 2000, usd: 5 }, maxAgents: 4, maxChildren: 3, maxDepth: 2 }, 'child');
    expect(narrowed.policy).toBeUndefined();
    expect(narrowed.issues.map(({ code, path, value }) => ({ code, path, value }))).toEqual([
      { code: 'policy-widening', path: 'child.tools', value: 'env.preview.fetch' },
      { code: 'policy-widening', path: 'child.budget.tokens', value: 'budget.tokens' },
      { code: 'policy-widening', path: 'child.maxAgents', value: 'maxAgents' },
      { code: 'policy-widening', path: 'child.maxChildren', value: 'maxChildren' },
      { code: 'policy-widening', path: 'child.maxDepth', value: 'maxDepth' },
    ]);
  });

  it('leaves absent ceilings open, as declarations do', () => {
    expect(narrowChildPolicy({}, { tools: ['env.run'], maxDepth: 9 })).toEqual({ policy: { maxDepth: 9, tools: ['env.run'] }, issues: [] });
  });

  it('reports a malformed fragment as invalid-value issues', () => {
    expect(narrowChildPolicy(parent, 'wide')).toMatchObject({ issues: [{ code: 'invalid-value', path: '' }] });
    expect(narrowChildPolicy(parent, { tools: ['env.*'], maxDepth: -1, isolation: 'os' }).issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['invalid-value', 'isolation'],
      ['invalid-value', 'maxDepth'],
      ['invalid-value', 'tools.0'],
    ]);
  });
});

function narrowNested(policy: AgentsPolicy) {
  return narrowChildPolicy(policy, undefined);
}
