/**
 * W12 shared contracts: the `env.*` tool keys, idempotency keys, run correlation
 * and the agent host port. Types and constants only, so the browser runtime and
 * the hosts build against one shape. No behaviour lives here.
 */

/** The environment tools an agent may be allowed; the one source of truth for the `env.*` namespace. */
export const ENV_TOOL_KEYS = ['env.fs.read', 'env.fs.write', 'env.fs.list', 'env.run', 'env.preview.fetch', 'env.services.status'] as const;
export type EnvToolKey = (typeof ENV_TOOL_KEYS)[number];

/** The `env.*` namespace prefix reserved for environment tools. */
export const ENV_TOOL_PREFIX = 'env.';

/** Whether each environment tool changes state (and so needs an idempotency key). */
export const ENV_TOOL_MUTATES: Readonly<Record<EnvToolKey, boolean>> = {
  'env.fs.read': false,
  'env.fs.write': true,
  'env.fs.list': false,
  'env.run': true,
  'env.preview.fetch': false,
  'env.services.status': false,
};

export const isEnvToolKey = (tool: string): tool is EnvToolKey => (ENV_TOOL_KEYS as readonly string[]).includes(tool);

/** Identifies one tool call of one run step, so a resumed run never repeats it. */
export interface IdempotencyKey {
  readonly runId: string;
  readonly step: number;
  readonly toolCallId: string;
}
export const idempotencyKeyString = (key: IdempotencyKey): string => `${key.runId}:${key.step}:${key.toolCallId}`;

/** Ties an event or record to its environment, runtime and agent. */
export interface EnvCorrelation {
  environmentId: string;
  runtimeId: string;
  agentId?: string;
  correlationId?: string;
}

export type AgentRunState = 'idle' | 'thinking' | 'executing' | 'waiting' | 'failed' | 'recovering';

export interface AgentHostEvent {
  readonly type: string;
  readonly correlation: EnvCorrelation;
  readonly payload: unknown;
  readonly ts: number;
}

/** What the runtime asks of the host that runs agents (start, steer, cancel, observe). */
export interface AgentHostPort {
  start(agentId: string, input: { task: string; correlation: EnvCorrelation }): Promise<{ runId: string }>;
  steer(runId: string, message: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  events(runId: string): AsyncIterable<AgentHostEvent>;
}

/** A typed refusal of an environment tool call. */
export interface EnvToolRefusal {
  code: 'tool-not-allowed' | 'shield-denied' | 'timeout';
  tool: string;
  detail: string;
}

/** The version stamped on every record the runtime persists. */
export const PERSISTED_FORMAT_VERSION = 1;
