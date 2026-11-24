/**
 * The ceiling comparisons of an `AgentsPolicy`: whether a tool list, a budget
 * or a count stays within a ceiling. The one source of `policy-widening`
 * issues, shared by `validateAgents` (a declaration against
 * `capabilities.agents`) and `narrowChildPolicy` (a child runtime against its
 * parent). A value above a ceiling is refused, never clamped; an absent
 * ceiling allows anything.
 */
import { AGENT_BUDGET_KEYS } from '../capabilities/agents.js';
import { manifestIssue, type ManifestIssue } from './issues.js';
import type { AgentBudget, AgentsPolicy } from './types.js';

export type AgentsPolicyCountKey = 'maxAgents' | 'maxDepth' | 'maxChildren';

/** A `policy-widening` issue at `path` for each tool not in `ceiling.tools`. */
export function toolWideningIssues(tools: readonly string[], ceiling: AgentsPolicy, path: string): ManifestIssue[] {
  const allowed = ceiling.tools;
  if (!allowed) return [];
  return tools
    .filter((tool) => !allowed.includes(tool))
    .map((tool) => manifestIssue('policy-widening', path, { value: tool, detail: `Allowed tools: ${allowed.join(', ') || 'none'}.` }));
}

/** A `policy-widening` issue at `path.<key>` for each budget entry above its ceiling in `ceiling.budget`. */
export function budgetWideningIssues(budget: AgentBudget, ceiling: AgentsPolicy, path: string): ManifestIssue[] {
  const limits = ceiling.budget;
  if (!limits) return [];
  return AGENT_BUDGET_KEYS.flatMap((key) => {
    const value = budget[key];
    const limit = limits[key];
    return typeof value === 'number' && limit !== undefined && value > limit
      ? [manifestIssue('policy-widening', `${path ? `${path}.` : ''}${key}`, { value: `budget.${key}`, detail: `The ceiling is ${limit}.` })]
      : [];
  });
}

/** A `policy-widening` issue at `path` when `value` is above `ceiling` (none when there is no ceiling). */
export function countWideningIssues(key: AgentsPolicyCountKey, value: number, ceiling: number | undefined, path: string, detail = `The ceiling is ${ceiling}.`): ManifestIssue[] {
  return ceiling !== undefined && value > ceiling ? [manifestIssue('policy-widening', path, { value: key, detail })] : [];
}
