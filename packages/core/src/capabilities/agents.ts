/**
 * The built-in `agents` capability: autonomous agents declared by role. Its
 * config, `capabilities.agents`, holds the environment's ceilings
 * (`AgentsPolicy`); a declaration may only narrow them. Hooks arrive with the
 * browser runtime (phase 3), so this definition has no `load`.
 */
import { isRecord } from '../manifest/overrides.js';
import type { AgentsPolicy } from '../manifest/types.js';
import { CHILD_RUNTIMES_CAPABILITY } from './childRuntimes.js';
import { createCapabilityRegistry, type CapabilityConfigIssue, type CapabilityDefinition } from './registry.js';

export const AGENTS_CAPABILITY_ID = 'agents';

/** A tool catalog key: dotted lowercase segments, no wildcards (`env.fs.read`). */
export const TOOL_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** A role or workload: a lowercase vocabulary key the host's model router resolves. */
export const AGENT_ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

export const AGENT_BUDGET_KEYS = ['tokens', 'usd', 'steps'] as const;
const POLICY_COUNT_KEYS = ['maxAgents', 'maxDepth', 'maxChildren'] as const;

const positive = { type: 'number', exclusiveMinimum: 0 };
const count = { type: 'integer', minimum: 0 };

/** JSON Schema of `AgentBudget`, shared by the policy and each agent. */
export const AGENT_BUDGET_SCHEMA = {
  type: 'object',
  properties: { tokens: positive, usd: positive, steps: positive },
  additionalProperties: false,
} as const;

/** JSON Schema of a tool allowlist. */
export const TOOL_LIST_SCHEMA = { type: 'array', items: { type: 'string', pattern: TOOL_KEY_PATTERN.source } } as const;

/** JSON Schema of `AgentsPolicy` (`capabilities.agents`). */
export const AGENTS_POLICY_SCHEMA = {
  type: 'object',
  properties: { maxAgents: count, maxDepth: count, maxChildren: count, tools: TOOL_LIST_SCHEMA, budget: AGENT_BUDGET_SCHEMA },
  additionalProperties: false,
} as const;

/** Issues in a budget (an object of positive numbers); paths are relative to it. */
export function budgetIssues(budget: unknown): CapabilityConfigIssue[] {
  if (budget === undefined) return [];
  if (!isRecord(budget)) return [{ path: '', detail: 'Expected an object of tokens, usd or steps.' }];
  return Object.entries(budget).flatMap(([key, value]): CapabilityConfigIssue[] => {
    if (!(AGENT_BUDGET_KEYS as readonly string[]).includes(key)) return [{ path: key, detail: `Use one of: ${AGENT_BUDGET_KEYS.join(', ')}.` }];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? [] : [{ path: key, detail: 'Expected a positive number.' }];
  });
}

/** Issues in a tool allowlist (a list of catalog keys); paths are the entry index. */
export function toolListIssues(tools: unknown): CapabilityConfigIssue[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) return [{ path: '', detail: 'Expected a list of tool keys.' }];
  return tools.flatMap((tool, index): CapabilityConfigIssue[] =>
    typeof tool === 'string' && TOOL_KEY_PATTERN.test(tool) ? [] : [{ path: String(index), detail: 'A tool key is dotted lowercase segments, e.g. "env.fs.read"; no wildcards.' }],
  );
}

const nested = (prefix: string, found: CapabilityConfigIssue[]): CapabilityConfigIssue[] =>
  found.map((issue) => ({ ...issue, path: issue.path ? `${prefix}.${issue.path}` : prefix }));

function validateAgentsPolicy(config: unknown): CapabilityConfigIssue[] {
  if (!isRecord(config)) return [{ path: '', detail: 'Expected an object of ceilings.' }];
  const issues: CapabilityConfigIssue[] = [];
  for (const key of Object.keys(config)) {
    if (!Object.hasOwn(AGENTS_POLICY_SCHEMA.properties, key)) {
      issues.push({ path: key, detail: `Use one of: ${Object.keys(AGENTS_POLICY_SCHEMA.properties).join(', ')}.` });
    }
  }
  const policy = config as Record<keyof AgentsPolicy, unknown>;
  for (const key of POLICY_COUNT_KEYS) {
    const value = policy[key];
    if (value !== undefined && !(typeof value === 'number' && Number.isInteger(value) && value >= 0)) issues.push({ path: key, detail: 'Expected a whole number, 0 or more.' });
  }
  issues.push(...nested('tools', toolListIssues(policy.tools)), ...nested('budget', budgetIssues(policy.budget)));
  return issues;
}

export const AGENTS_CAPABILITY: CapabilityDefinition = {
  id: AGENTS_CAPABILITY_ID,
  version: 1,
  dependsOn: [],
  requires: ['ai'],
  configSchema: AGENTS_POLICY_SCHEMA,
  validateConfig: validateAgentsPolicy,
};

/** The capabilities core ships: `agents` and `child-runtimes`. */
export const BUILTIN_CAPABILITIES = createCapabilityRegistry([AGENTS_CAPABILITY, CHILD_RUNTIMES_CAPABILITY]);
