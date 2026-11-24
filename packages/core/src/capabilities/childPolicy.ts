/**
 * `narrowChildPolicy`: the policy a child runtime runs under, derived from its
 * parent's. A child may only narrow its parent: tools a subset, each budget
 * entry and each count at most the parent's. A widening is refused (a typed
 * `policy-widening` issue), never clamped, through the same ceiling checks
 * `validateAgents` uses.
 *
 * Depth: `maxDepth` is how many levels of child runtimes may sit below the
 * runtime holding the policy. A child sits one level below its parent, so it
 * may be started only when the parent's `maxDepth` is at least 1, and its own
 * `maxDepth` is at most the parent's minus one (it inherits exactly that when
 * the fragment names none). From a root whose `maxDepth` is M, a runtime at
 * depth d (the root is 0) is allowed iff d <= M: depth M is allowed, M + 1 is
 * refused. An absent ceiling allows anything, as it does for declarations.
 */
import { manifestIssue, type ManifestIssue } from '../manifest/issues.js';
import { budgetWideningIssues, countWideningIssues, toolWideningIssues, type AgentsPolicyCountKey } from '../manifest/agentsPolicy.js';
import type { AgentsPolicy } from '../manifest/types.js';
import { AGENTS_CAPABILITY } from './agents.js';

export interface NarrowedChildPolicy {
  /** The child's policy; absent when `issues` holds an error. */
  policy?: AgentsPolicy;
  issues: ManifestIssue[];
}

const at = (prefix: string, key: string): string => (prefix ? `${prefix}.${key}` : key);

/**
 * Narrow `parent` by `fragment` (the child's `AgentsPolicy`-shaped ceilings;
 * `undefined` inherits them). Issue paths are relative to the fragment, under
 * `path` when one is given.
 */
export function narrowChildPolicy(parent: AgentsPolicy, fragment: unknown, path = ''): NarrowedChildPolicy {
  if (parent.maxDepth !== undefined && parent.maxDepth < 1) {
    return { issues: [manifestIssue('policy-widening', path, { value: 'maxDepth', detail: `The parent's maxDepth is ${parent.maxDepth}: a child would sit one level deeper than allowed.` })] };
  }
  const given = fragment ?? {};
  const invalid = (AGENTS_CAPABILITY.validateConfig?.(given) ?? []).map((issue) => manifestIssue('invalid-value', issue.path ? at(path, issue.path) : path, { detail: issue.detail }));
  if (invalid.length > 0) return { issues: invalid };
  const child = given as AgentsPolicy;
  const depthCeiling = parent.maxDepth === undefined ? undefined : parent.maxDepth - 1;
  const countCeilings: Record<AgentsPolicyCountKey, number | undefined> = { maxAgents: parent.maxAgents, maxChildren: parent.maxChildren, maxDepth: depthCeiling };
  const issues: ManifestIssue[] = [
    ...(child.tools ? toolWideningIssues(child.tools, parent, at(path, 'tools')) : []),
    ...(child.budget ? budgetWideningIssues(child.budget, parent, at(path, 'budget')) : []),
  ];
  const policy: AgentsPolicy = {};
  for (const key of Object.keys(countCeilings) as AgentsPolicyCountKey[]) {
    const ceiling = countCeilings[key];
    const value = child[key];
    if (value !== undefined) {
      const detail = key === 'maxDepth' ? `A child sits one level below its parent: at most ${ceiling}.` : undefined;
      issues.push(...countWideningIssues(key, value, ceiling, at(path, key), detail));
    }
    const narrowed = value ?? ceiling;
    if (narrowed !== undefined) policy[key] = narrowed;
  }
  if (issues.length > 0) return { issues };
  const tools = child.tools ?? parent.tools;
  if (tools) policy.tools = [...tools];
  const budget = { ...parent.budget, ...child.budget };
  if (Object.keys(budget).length > 0) policy.budget = budget;
  return { policy, issues };
}
