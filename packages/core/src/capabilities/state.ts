/**
 * The built-in `state` capability: how each kind of environment state persists
 * (01-WEBCONTAINERS.md › State management). Config is `capabilities.state`; an
 * absent key takes its default. Secrets are never configurable: they are always
 * secure references, never snapshotted. Processes, connections and databases are
 * not here: they are recreated from the manifest, re-established, or persisted
 * by the resource itself (`persistent`). The runtime carries the behaviour; this
 * definition has no `load`.
 *
 * Imports nothing from `./agents.js`, which lists this definition in
 * `BUILTIN_CAPABILITIES`.
 */
import { isRecord } from '../manifest/overrides.js';
import type { StatePolicy } from '../manifest/types.js';
import type { CapabilityConfigIssue, CapabilityDefinition } from './registry.js';

export const STATE_CAPABILITY_ID = 'state';

/** Each configurable state kind, its allowed strategies, default first. */
export const STATE_STRATEGIES = {
  source: ['journal', 'snapshot'],
  transcripts: ['durable', 'none'],
  checkpoints: ['durable', 'none'],
  tempFiles: ['ephemeral', 'durable'],
} as const satisfies Record<keyof StatePolicy, readonly string[]>;

type StateKind = keyof typeof STATE_STRATEGIES;
const STATE_KINDS = Object.keys(STATE_STRATEGIES) as StateKind[];

/** The policy an environment has for every kind it does not set. */
export const STATE_POLICY_DEFAULTS: Readonly<Required<StatePolicy>> = Object.freeze(
  Object.fromEntries(STATE_KINDS.map((kind) => [kind, STATE_STRATEGIES[kind][0]])) as Required<StatePolicy>,
);

/** JSON Schema of `capabilities.state`. */
export const STATE_CONFIG_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(STATE_KINDS.map((kind) => [kind, { enum: [...STATE_STRATEGIES[kind]], default: STATE_STRATEGIES[kind][0] }])),
  additionalProperties: false,
} as const;

const SECRETS_DETAIL = 'Secrets are always secure references and are never snapshotted; remove this key.';

function validateStateConfig(config: unknown): CapabilityConfigIssue[] {
  if (!isRecord(config)) return [{ path: '', detail: `Expected an object of ${STATE_KINDS.join(', ')}.` }];
  return Object.entries(config).flatMap(([key, value]): CapabilityConfigIssue[] => {
    if (key === 'secrets') return [{ path: key, detail: SECRETS_DETAIL }];
    if (!Object.hasOwn(STATE_STRATEGIES, key)) return [{ path: key, detail: `Use one of: ${STATE_KINDS.join(', ')}.` }];
    const allowed: readonly string[] = STATE_STRATEGIES[key as StateKind];
    return typeof value === 'string' && allowed.includes(value) ? [] : [{ path: key, detail: `Use one of: ${allowed.join(', ')}.` }];
  });
}

export const STATE_CAPABILITY: CapabilityDefinition = {
  id: STATE_CAPABILITY_ID,
  version: 1,
  dependsOn: [],
  requires: [],
  configSchema: STATE_CONFIG_SCHEMA,
  validateConfig: validateStateConfig,
};
