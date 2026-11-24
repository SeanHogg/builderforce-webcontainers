/**
 * `capabilities` and `agents` of a v1 manifest. A capability is checked against
 * the registry the environment injects; agents are declared by role (never a
 * model id) and may only narrow the ceilings in `capabilities.agents`, so a
 * declaration above one is refused, never clamped.
 */
import { SERVICE_ID } from '../app/validateSpec.js';
import { AGENT_ROLE_PATTERN, AGENTS_CAPABILITY, AGENTS_CAPABILITY_ID, budgetIssues, toolListIssues } from '../capabilities/agents.js';
import { ENV_TOOL_KEYS, ENV_TOOL_PREFIX, isEnvToolKey } from '../agents/contract.js';
import { orderCapabilities, type CapabilityConfigIssue, type CapabilityRegistry } from '../capabilities/registry.js';
import { resourceCapability } from './capabilities.js';
import { checkIds, checkSchedule, checkTimeZone, checkType, isNonEmptyString, section, stringArray, type Issues } from './checks.js';
import { manifestIssue } from './issues.js';
import { environmentsOf, hasOwnKey, isRecord } from './overrides.js';
import { budgetWideningIssues, countWideningIssues, toolWideningIssues } from './agentsPolicy.js';
import { PATH_ISSUE_DETAIL, validateWorkspacePath } from './paths.js';
import { MANIFEST_TARGETS, type AgentsPolicy, type AppManifest } from './types.js';

/** Keys that pick a model; the host's router does that from the role. */
const MODEL_KEYS = ['model', 'models', 'modelId', 'provider'];
const ROLE_KEYS = ['role', 'workload'] as const;
/** Characters of a model id (`anthropic/claude`, `gpt-4o:latest`, `claude-3.5`), never of a role. */
const MODEL_ID_CHARS = /[/:.]/;
/** Each trigger shape by its one identifying key, with every key it allows. */
const TRIGGER_KEYS: Readonly<Record<string, readonly string[]>> = {
  manual: ['manual'],
  cron: ['cron', 'timezone'],
  service: ['service', 'event'],
};
const TRIGGER_DETAIL = 'A trigger is { "manual": true }, { "cron", "timezone"? } or { "service", "event" }.';

/** Each config issue as an `invalid-value` under `prefix`. */
function pushConfigIssues(found: readonly CapabilityConfigIssue[], prefix: string, issues: Issues): void {
  for (const issue of found) issues.push(manifestIssue('invalid-value', issue.path ? `${prefix}.${issue.path}` : prefix, { detail: issue.detail }));
}

/** `capabilities`: each id registered, its dependencies enabled and acyclic, its config valid, its requirements met by each environment's target. */
export function validateCapabilities(manifest: AppManifest, registry: CapabilityRegistry, issues: Issues): void {
  const enabled = section(manifest.capabilities, 'capabilities', issues);
  checkIds(enabled, 'capabilities', issues);
  const known: string[] = [];
  for (const [id, config] of Object.entries(enabled)) {
    const path = `capabilities.${id}`;
    const definition = registry.get(id);
    if (!definition) {
      issues.push(manifestIssue('unknown-capability', path, { value: id }));
      continue;
    }
    known.push(id);
    for (const dependency of definition.dependsOn) {
      if (!hasOwnKey(enabled, dependency)) issues.push(manifestIssue('capability-missing-dependency', path, { value: dependency }));
    }
    pushConfigIssues(definition.validateConfig?.(config) ?? [], path, issues);
  }
  const order = orderCapabilities(known, registry);
  if (!order.ok) issues.push(manifestIssue('capability-dependency-cycle', 'capabilities', { detail: order.cycle.join(' → ') }));
  for (const [name, environment] of Object.entries(environmentsOf(manifest))) {
    const target: unknown = isRecord(environment) ? environment.target : undefined;
    // An unknown target is already an `unknown-target` error.
    if (!(MANIFEST_TARGETS as readonly unknown[]).includes(target)) continue;
    for (const id of known) {
      for (const type of registry.get(id)!.requires) {
        const capability = resourceCapability(type, target as string);
        if (!capability.supported) issues.push(manifestIssue('capability-unsupported-target', `environments.${name}`, { severity: 'warning', value: id, detail: `It needs "${type}": ${capability.reason ?? 'unsupported'}.` }));
      }
    }
  }
}

/** The usable ceilings: `capabilities.agents` when it is valid (its issues are reported by `validateCapabilities`), otherwise none. */
function agentsPolicy(manifest: AppManifest): AgentsPolicy {
  const enabled = isRecord(manifest.capabilities) ? manifest.capabilities : {};
  const config = hasOwnKey(enabled, AGENTS_CAPABILITY_ID) ? enabled[AGENTS_CAPABILITY_ID] : undefined;
  return isRecord(config) && (AGENTS_CAPABILITY.validateConfig?.(config) ?? []).length === 0 ? (config as AgentsPolicy) : {};
}

function validateRole(entry: Record<string, unknown>, path: string, issues: Issues): void {
  const given = ROLE_KEYS.filter((key) => entry[key] !== undefined);
  if (given.length === 0) {
    issues.push(manifestIssue('missing-field', path, { value: 'role' }));
    return;
  }
  if (given.length > 1) {
    issues.push(manifestIssue('invalid-value', path, { detail: 'Declare a role or a workload, not both.' }));
    return;
  }
  const key = given[0]!;
  const value = entry[key];
  if (typeof value === 'string' && AGENT_ROLE_PATTERN.test(value)) return;
  if (typeof value === 'string' && MODEL_ID_CHARS.test(value)) issues.push(manifestIssue('agent-model-id', `${path}.${key}`, { value }));
  else issues.push(manifestIssue('invalid-value', `${path}.${key}`, { value: String(value), detail: 'A role is a lowercase key, e.g. "developer".' }));
}

function validateInstructions(instructions: unknown, path: string, issues: Issues): void {
  if (typeof instructions !== 'string') {
    checkType(instructions, 'string', path, issues);
    return;
  }
  const code = validateWorkspacePath(instructions);
  if (code) issues.push(manifestIssue('invalid-path', path, { value: instructions, detail: PATH_ISSUE_DETAIL[code] }));
}

function validateTools(tools: unknown, path: string, policy: AgentsPolicy, issues: Issues): void {
  const found = toolListIssues(tools);
  pushConfigIssues(found, path, issues);
  if (found.length > 0 || !Array.isArray(tools)) return;
  for (const tool of tools as string[]) {
    if (tool.startsWith(ENV_TOOL_PREFIX) && !isEnvToolKey(tool)) issues.push(manifestIssue('invalid-value', path, { value: tool, detail: `Environment tools: ${ENV_TOOL_KEYS.join(', ')}.` }));
  }
  issues.push(...toolWideningIssues(tools as string[], policy, path));
}

function validateBudget(budget: unknown, path: string, policy: AgentsPolicy, issues: Issues): void {
  const found = budgetIssues(budget);
  pushConfigIssues(found, path, issues);
  if (found.length > 0 || !isRecord(budget)) return;
  issues.push(...budgetWideningIssues(budget, policy, path));
}

function validateTriggers(triggers: unknown, path: string, services: Record<string, unknown>, issues: Issues): void {
  if (triggers === undefined) return;
  if (!Array.isArray(triggers)) {
    issues.push(manifestIssue('invalid-value', path, { detail: 'Expected a list of triggers.' }));
    return;
  }
  triggers.forEach((trigger: unknown, index) => {
    const at = `${path}.${index}`;
    const kinds = isRecord(trigger) ? Object.keys(TRIGGER_KEYS).filter((kind) => trigger[kind] !== undefined) : [];
    const kind = kinds.length === 1 ? kinds[0]! : undefined;
    if (!kind || !Object.keys(trigger as Record<string, unknown>).every((key) => TRIGGER_KEYS[kind]!.includes(key))) {
      issues.push(manifestIssue('invalid-value', at, { detail: TRIGGER_DETAIL }));
      return;
    }
    const entry = trigger as Record<string, unknown>;
    if (kind === 'manual') {
      if (entry.manual !== true) issues.push(manifestIssue('invalid-value', `${at}.manual`, { value: String(entry.manual), detail: 'Set it to true.' }));
    } else if (kind === 'cron') {
      checkSchedule(entry.cron, `${at}.cron`, issues);
      checkTimeZone(entry.timezone, `${at}.timezone`, issues);
    } else {
      if (typeof entry.service !== 'string' || !hasOwnKey(services, entry.service)) issues.push(manifestIssue('unknown-service', `${at}.service`, { value: String(entry.service) }));
      if (!isNonEmptyString(entry.event)) issues.push(manifestIssue('missing-field', at, { value: 'event' }));
    }
  });
}

/** `agents`: each declared by role within the ceilings of `capabilities.agents`, which must be enabled. */
export function validateAgents(manifest: AppManifest, services: Record<string, unknown>, issues: Issues): void {
  const agents = section(manifest.agents, 'agents', issues);
  checkIds(agents, 'agents', issues);
  const ids = Object.keys(agents);
  if (ids.length === 0) return;
  const enabled = isRecord(manifest.capabilities) ? manifest.capabilities : {};
  if (!hasOwnKey(enabled, AGENTS_CAPABILITY_ID)) issues.push(manifestIssue('capability-not-enabled', 'agents', { value: AGENTS_CAPABILITY_ID }));
  const policy = agentsPolicy(manifest);
  issues.push(...countWideningIssues('maxAgents', ids.length, policy.maxAgents, 'agents', `At most ${policy.maxAgents} agents; ${ids.length} are declared.`));
  for (const [id, entry] of Object.entries(agents)) {
    const path = `agents.${id}`;
    if (!isRecord(entry)) {
      issues.push(manifestIssue('invalid-value', path, { detail: 'Expected an agent object.' }));
      continue;
    }
    for (const key of MODEL_KEYS) if (hasOwnKey(entry, key)) issues.push(manifestIssue('agent-model-id', `${path}.${key}`, { value: key }));
    validateRole(entry, path, issues);
    validateInstructions(entry.instructions, `${path}.instructions`, issues);
    stringArray(entry.skills, `${path}.skills`, issues);
    validateTools(entry.tools, `${path}.tools`, policy, issues);
    if (entry.memory !== undefined && !(typeof entry.memory === 'string' && SERVICE_ID.test(entry.memory))) {
      issues.push(manifestIssue('invalid-value', `${path}.memory`, { value: String(entry.memory), detail: 'A memory namespace starts with a letter and has only letters, digits, "_" and "-".' }));
    }
    validateTriggers(entry.triggers, `${path}.triggers`, services, issues);
    validateBudget(entry.budget, `${path}.budget`, policy, issues);
  }
}
