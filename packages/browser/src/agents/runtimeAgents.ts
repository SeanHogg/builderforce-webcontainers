/**
 * The `runtime.agents.*` tools on the browser host (W12 phase 3): list the
 * agents a manifest declares, start one through the host's `AgentHostPort`,
 * and steer, cancel or read a run it started.
 *
 * Every handler resolves an agent's tools the same way, through core's
 * `allowedTools`: the ONE catalog (the host's catalog keys plus the `env.*`
 * environment tools) ∩ that agent's allowlist. It fails closed: an agent id the
 * manifest does not declare is refused, a tool outside the resolved set is
 * refused, a run this host did not start is refused, and a listing never shows
 * a tool outside the resolved set. A refusal is typed; nothing here throws for
 * a caller's input. A failure of the host port itself is not a refusal and is
 * raised to the caller.
 */
import { allowedTools, ENV_TOOL_KEYS, type AgentHostPort, type EnvCorrelation } from '@seanhogg/builderforce-webcontainers-core';
import type { AgentDeclaration } from '@seanhogg/builderforce-webcontainers-core/manifest';

export const RUNTIME_AGENTS_LIST = 'runtime.agents.list';
export const RUNTIME_AGENTS_STATUS = 'runtime.agents.status';
export const RUNTIME_AGENTS_START = 'runtime.agents.start';
export const RUNTIME_AGENTS_STEER = 'runtime.agents.steer';
export const RUNTIME_AGENTS_CANCEL = 'runtime.agents.cancel';

/** The `runtime.agents.*` tool keys, in the order the catalog lists them. */
export const RUNTIME_AGENTS_TOOL_KEYS = [RUNTIME_AGENTS_LIST, RUNTIME_AGENTS_STATUS, RUNTIME_AGENTS_START, RUNTIME_AGENTS_STEER, RUNTIME_AGENTS_CANCEL] as const;
export type RuntimeAgentsToolKey = (typeof RUNTIME_AGENTS_TOOL_KEYS)[number];

/** Whether each `runtime.agents.*` tool changes state, advertised like the catalog's `mutates`. */
export const RUNTIME_AGENTS_MUTATES: Readonly<Record<RuntimeAgentsToolKey, boolean>> = {
  [RUNTIME_AGENTS_LIST]: false,
  [RUNTIME_AGENTS_STATUS]: false,
  [RUNTIME_AGENTS_START]: true,
  [RUNTIME_AGENTS_STEER]: true,
  [RUNTIME_AGENTS_CANCEL]: true,
};

export interface RuntimeAgentsRefusal {
  code: 'unknown-tool' | 'invalid-argument' | 'agent-not-declared' | 'tool-not-allowed' | 'run-not-found';
  detail: string;
}

export type RuntimeAgentsResult<T = unknown> = { ok: true; result: T } | { ok: false; refusal: RuntimeAgentsRefusal };

/** One declared agent as the tools show it: its tools are already the resolved set. */
export interface RuntimeAgentSummary {
  readonly id: string;
  readonly role: string | null;
  readonly tools: readonly string[];
}

/** A run this host started. */
export interface RuntimeAgentRun {
  readonly runId: string;
  readonly agentId: string;
  readonly tools: readonly string[];
}

export interface RuntimeAgentsDeps {
  host: Pick<AgentHostPort, 'start' | 'steer' | 'cancel'>;
  /** The manifest's validated `agents`, read at call time. */
  agents(): Readonly<Record<string, AgentDeclaration>>;
  /** The ONE tool catalog's keys, read at call time; the `env.*` tools are added by the runtime. */
  catalog(): readonly string[];
  /** The environment and runtime every run is correlated with; `agentId` is added per run. */
  correlation: Pick<EnvCorrelation, 'environmentId' | 'runtimeId'>;
}

export interface RuntimeAgents {
  call(tool: RuntimeAgentsToolKey, args?: unknown): Promise<RuntimeAgentsResult>;
  /** Whether `agentId` may call `tool`, for the host's capabilities port; the same resolution every handler uses. */
  authorize(agentId: string, tool: string): RuntimeAgentsResult<string>;
  /** The runs still going, for the `agents` capability's `activeRuns`. */
  activeRuns(): readonly string[];
  readonly mutates: typeof RUNTIME_AGENTS_MUTATES;
}

/** Thrown inside a handler to refuse the call; turned into a typed refusal by `call`. */
class Refused extends Error {
  constructor(
    readonly code: RuntimeAgentsRefusal['code'],
    detail: string,
  ) {
    super(detail);
  }
}

/** A `Refused` as its typed refusal; anything else is not the caller's doing and is raised. */
function refusalOf(error: unknown): { ok: false; refusal: RuntimeAgentsRefusal } {
  if (error instanceof Refused) return { ok: false, refusal: { code: error.code, detail: error.message } };
  throw error;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isToolKey = (tool: unknown): tool is RuntimeAgentsToolKey => (RUNTIME_AGENTS_TOOL_KEYS as readonly unknown[]).includes(tool);

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (!isRecord(args)) throw new Refused('invalid-argument', 'Arguments must be an object.');
  return args;
}

function textArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Refused('invalid-argument', `"${name}" must be a non-empty string.`);
  return text;
}

export function createRuntimeAgents(deps: RuntimeAgentsDeps): RuntimeAgents {
  const runs = new Map<string, RuntimeAgentRun>();

  /** The agent's declaration; an id the manifest does not declare (an inherited key included) is refused. */
  function declared(agentId: string): AgentDeclaration {
    const agents = deps.agents();
    const declaration = Object.hasOwn(agents, agentId) ? agents[agentId] : undefined;
    if (!isRecord(declaration)) throw new Refused('agent-not-declared', `No agent "${agentId}" is declared in the manifest.`);
    return declaration;
  }

  /** The one resolution: the catalog (with the environment tools) ∩ the agent's allowlist. */
  const toolsOf = (declaration: AgentDeclaration): string[] => allowedTools([...ENV_TOOL_KEYS, ...deps.catalog()], declaration.tools);

  function runOf(args: Record<string, unknown>): RuntimeAgentRun {
    const runId = textArg(args, 'runId');
    const run = runs.get(runId);
    if (!run) throw new Refused('run-not-found', `No run "${runId}" was started on this runtime.`);
    return run;
  }

  /** The run, re-resolved against the current manifest and catalog: a run whose agent is gone is refused. */
  const currentRun = (run: RuntimeAgentRun): RuntimeAgentRun => ({ ...run, tools: toolsOf(declared(run.agentId)) });

  const handlers: Record<RuntimeAgentsToolKey, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
    [RUNTIME_AGENTS_LIST]: (): RuntimeAgentSummary[] =>
      Object.entries(deps.agents())
        .filter((entry): entry is [string, AgentDeclaration] => isRecord(entry[1]))
        .map(([id, declaration]) => ({ id, role: declaration.role ?? declaration.workload ?? null, tools: toolsOf(declaration) })),
    [RUNTIME_AGENTS_STATUS]: (args) => currentRun(runOf(args)),
    [RUNTIME_AGENTS_START]: async (args): Promise<RuntimeAgentRun> => {
      const agentId = textArg(args, 'agentId');
      const task = textArg(args, 'task');
      const tools = toolsOf(declared(agentId));
      const { runId } = await deps.host.start(agentId, { task, correlation: { ...deps.correlation, agentId } });
      const run = { runId, agentId, tools };
      runs.set(runId, run);
      return run;
    },
    [RUNTIME_AGENTS_STEER]: async (args) => {
      const run = currentRun(runOf(args));
      await deps.host.steer(run.runId, textArg(args, 'message'));
      return { runId: run.runId, steered: true };
    },
    [RUNTIME_AGENTS_CANCEL]: async (args) => {
      const run = runOf(args);
      await deps.host.cancel(run.runId);
      runs.delete(run.runId);
      return { runId: run.runId, cancelled: true };
    },
  };

  return {
    mutates: RUNTIME_AGENTS_MUTATES,
    async call(tool, args) {
      try {
        if (!isToolKey(tool)) throw new Refused('unknown-tool', `"${String(tool)}" is not a runtime.agents tool.`);
        return { ok: true, result: await handlers[tool](argsRecord(args)) };
      } catch (error) {
        return refusalOf(error);
      }
    },
    authorize(agentId, tool) {
      try {
        if (!toolsOf(declared(agentId)).includes(tool)) throw new Refused('tool-not-allowed', `"${tool}" is not on agent "${agentId}"'s allowlist, or not in the catalog.`);
        return { ok: true, result: tool };
      } catch (error) {
        return refusalOf(error);
      }
    },
    activeRuns: () => [...runs.keys()],
  };
}
