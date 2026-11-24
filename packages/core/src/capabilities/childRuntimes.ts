/**
 * The built-in `child-runtimes` capability: a runtime may start child runtimes,
 * each under a policy narrowed from its parent's (`narrowChildPolicy`). It
 * depends on `agents`, whose config (`capabilities.agents`) holds the ceilings
 * a child inherits, so its own config is an empty object. The browser runtime
 * (`createChildRuntimes`) carries the behaviour; this definition has no `load`.
 *
 * Imports nothing from `./agents.js`, which lists this definition in
 * `BUILTIN_CAPABILITIES`, so the two never form an import cycle.
 */
import { isRecord } from '../manifest/overrides.js';
import type { CapabilityConfigIssue, CapabilityDefinition } from './registry.js';

export const CHILD_RUNTIMES_CAPABILITY_ID = 'child-runtimes';

/** JSON Schema of `capabilities.child-runtimes`: no settings of its own. */
export const CHILD_RUNTIMES_CONFIG_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

function validateChildRuntimesConfig(config: unknown): CapabilityConfigIssue[] {
  if (!isRecord(config)) return [{ path: '', detail: 'Expected an empty object; the ceilings are in capabilities.agents.' }];
  return Object.keys(config).map((key) => ({ path: key, detail: 'capabilities.child-runtimes has no settings; set the ceilings (maxDepth, maxChildren) in capabilities.agents.' }));
}

export const CHILD_RUNTIMES_CAPABILITY: CapabilityDefinition = {
  id: CHILD_RUNTIMES_CAPABILITY_ID,
  version: 1,
  // `AGENTS_CAPABILITY_ID`, spelled out to keep `./agents.js` out of this module's imports.
  dependsOn: ['agents'],
  requires: [],
  configSchema: CHILD_RUNTIMES_CONFIG_SCHEMA,
  validateConfig: validateChildRuntimesConfig,
};
