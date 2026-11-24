/**
 * The `env.*` tool port (W12 phase 3): the one chokepoint through which an
 * agent touches its environment — the project files, processes, its own
 * services' HTTP and their status. Every call is checked, in order: the tool is
 * on the agent's allowlist, a mutating tool carries an idempotency key, the
 * arguments are well formed, a path stays inside the project (no absolute path,
 * no `..`) and a fetch targets one of the environment's own services by id —
 * never a host or a port the agent names. A refusal is typed and reported to
 * the Security Shield's telemetry; nothing here throws for an agent's input.
 */
import {
  allowedTools,
  ENV_TOOL_KEYS,
  ENV_TOOL_MUTATES,
  idempotencyKeyString,
  normalizePath,
  type EnvToolKey,
  type EnvToolRefusal,
  type IdempotencyKey,
  type ShieldReasonCode,
  type VirtualFileSystem,
} from '@seanhogg/builderforce-webcontainers-core';
import { validateWorkspacePath, PATH_ISSUE_DETAIL } from '@seanhogg/builderforce-webcontainers-core/manifest';
import type { ApplicationRuntime } from '../app/types.js';
import type { PreviewRuntime } from '../runtimeOptions.js';
import { applicationContext } from '../security/securityEvent.js';
import type { ShieldReporter } from '../security/shieldTelemetry.js';

/** How long `env.run` waits for a process before it is killed and the call refused with `timeout`. */
export const ENV_RUN_DEFAULT_TIMEOUT_MS = 60_000;
/** The most output `env.run` (and the most body `env.preview.fetch`) returns; past it the text is cut and `truncated` set. */
export const ENV_OUTPUT_LIMIT_BYTES = 256 * 1024;
/** The largest file `env.fs.write` accepts. */
export const ENV_FS_WRITE_LIMIT_BYTES = 1024 * 1024;
/** `env.preview.fetch` only reads: these methods, and no request body. */
export const ENV_FETCH_METHODS = ['GET', 'HEAD'] as const;
/** The signal a timed-out `env.run` process is ended with: it must not outlive its call. */
const TIMEOUT_KILL_SIGNAL = 'SIGKILL';

export interface EnvironmentToolPortDeps {
  fs: Pick<VirtualFileSystem, 'readText' | 'writeFile' | 'entries' | 'isFile' | 'isDirectory'>;
  runtime: Pick<PreviewRuntime, 'run' | 'request'>;
  /** The environment's application: its services are the only ones `env.preview.fetch` reaches; its id attributes Shield events. */
  app: Pick<ApplicationRuntime, 'listServices' | 'applicationId'>;
  shield: ShieldReporter;
  /** `env.run`'s timeout. Default {@link ENV_RUN_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface EnvironmentAgent {
  readonly id: string;
  /** The agent's effective allowlist (its declaration narrowed by the environment's ceilings). */
  readonly tools: readonly string[];
}

export type EnvToolResult = { ok: true; result: unknown } | { ok: false; refusal: EnvToolRefusal };

export interface EnvironmentToolPort {
  call(tool: EnvToolKey, args: unknown, key?: IdempotencyKey): Promise<EnvToolResult>;
  readonly mutates: typeof ENV_TOOL_MUTATES;
}

/** Thrown inside a handler to refuse the call; turned into a typed, reported refusal by `call`. */
class Refused extends Error {
  constructor(
    readonly code: EnvToolRefusal['code'],
    readonly reason: ShieldReasonCode,
    detail: string,
  ) {
    super(detail);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function argsRecord(args: unknown): Record<string, unknown> {
  if (args === undefined) return {};
  if (!isRecord(args)) throw new Refused('shield-denied', 'agent.tool_not_allowed', 'Arguments must be an object.');
  return args;
}

function stringArg(args: Record<string, unknown>, name: string, fallback?: string): string {
  const value = args[name] ?? fallback;
  if (typeof value !== 'string') throw new Refused('shield-denied', 'agent.tool_not_allowed', `"${name}" must be a string.`);
  return value;
}

/** A project-relative path → the VFS's absolute one, or a refusal for an absolute or `..` path. */
function workspacePath(value: string): string {
  const issue = validateWorkspacePath(value);
  if (issue) throw new Refused('shield-denied', 'agent.path_invalid', `Path "${value}" is refused: ${PATH_ISSUE_DETAIL[issue]}`);
  return normalizePath(`/${value.trim()}`);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Appends text to a byte-capped buffer; `truncated` once anything was cut. */
function cappedText(limit: number) {
  let text = '';
  let bytes = 0;
  let truncated = false;
  return {
    /** False once the cap is reached (the caller may stop reading). */
    push(chunk: string): boolean {
      if (truncated) return false;
      const encoded = encoder.encode(chunk);
      if (bytes + encoded.byteLength <= limit) {
        text += chunk;
        bytes += encoded.byteLength;
        return true;
      }
      text += decoder.decode(encoded.subarray(0, limit - bytes));
      bytes = limit;
      truncated = true;
      return false;
    },
    result: () => ({ text, truncated }),
  };
}

export function createEnvironmentToolPort(deps: EnvironmentToolPortDeps, agent: EnvironmentAgent): EnvironmentToolPort {
  const timeoutMs = deps.timeoutMs ?? ENV_RUN_DEFAULT_TIMEOUT_MS;
  // The environment tools ∩ the agent's allowlist: an allowlist entry that is not an `env.*` key grants nothing.
  const allowed: ReadonlySet<string> = new Set(allowedTools(ENV_TOOL_KEYS, agent.tools));
  const context = applicationContext(deps.app.applicationId);

  const handlers: Record<EnvToolKey, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
    'env.fs.read': (args) => {
      const path = workspacePath(stringArg(args, 'path'));
      const content = deps.fs.isFile(path) ? deps.fs.readText(path) : undefined;
      return content === undefined ? { path, found: false } : { path, found: true, content };
    },
    'env.fs.write': (args) => {
      const path = workspacePath(stringArg(args, 'path'));
      const content = stringArg(args, 'content');
      if (encoder.encode(content).byteLength > ENV_FS_WRITE_LIMIT_BYTES) {
        throw new Refused('shield-denied', 'agent.tool_not_allowed', `File content exceeds ${ENV_FS_WRITE_LIMIT_BYTES} bytes.`);
      }
      deps.fs.writeFile(path, content);
      return { path, written: true };
    },
    'env.fs.list': (args) => {
      const path = workspacePath(stringArg(args, 'path', '.'));
      return { path, entries: deps.fs.isDirectory(path) ? deps.fs.entries(path) : [] };
    },
    'env.run': async (args) => {
      const command = stringArg(args, 'command');
      const argv = args.args ?? [];
      if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string')) throw new Refused('shield-denied', 'agent.tool_not_allowed', '"args" must be a list of strings.');
      const cwd = args.cwd === undefined ? undefined : workspacePath(stringArg(args, 'cwd'));
      return runProcess(command, argv as string[], cwd);
    },
    'env.preview.fetch': async (args) => {
      const serviceId = stringArg(args, 'service');
      const path = stringArg(args, 'path', '/');
      // Path and query only: a scheme, a protocol-relative `//host`, a backslash or a control character could name another host.
      if (!path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path)) {
        throw new Refused('shield-denied', 'agent.service_not_allowed', 'A fetch path is a path and query on the service, e.g. "/api/health".');
      }
      const method = stringArg(args, 'method', 'GET').toUpperCase();
      if (!(ENV_FETCH_METHODS as readonly string[]).includes(method)) {
        throw new Refused('shield-denied', 'agent.tool_not_allowed', `Use one of: ${ENV_FETCH_METHODS.join(', ')}.`);
      }
      const service = deps.app.listServices().find((candidate) => candidate.id === serviceId);
      if (!service) throw new Refused('shield-denied', 'agent.service_not_allowed', `"${serviceId}" is not a service of this environment.`);
      if (service.port === undefined) return { service: serviceId, listening: false };
      const response = await deps.runtime.request(service.port, { url: path, method });
      if (!response) return { service: serviceId, listening: false };
      const body = cappedText(ENV_OUTPUT_LIMIT_BYTES);
      body.push(decoder.decode(response.body));
      const { text, truncated } = body.result();
      return { service: serviceId, listening: true, status: response.status, headers: response.headers, body: text, truncated };
    },
    'env.services.status': () =>
      deps.app.listServices().map(({ id, state, port, url, restarts, exitCode }) => ({ id, state, port, url, restarts, exitCode })),
  };

  async function runProcess(command: string, argv: string[], cwd: string | undefined) {
    const child = deps.runtime.run(command, argv, cwd === undefined ? {} : { cwd });
    const output = cappedText(ENV_OUTPUT_LIMIT_BYTES);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const timedOut = new Promise<'timeout'>((resolve) => controller.signal.addEventListener('abort', () => resolve('timeout'), { once: true }));
    const reader = child.combinedOutput.getReader();
    const collect = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Past the cap, stop reading: the process still runs to its exit, its output is dropped.
        if (!output.push(value)) return void (await reader.cancel());
      }
    })();
    try {
      const outcome = await Promise.race([Promise.all([child.wait(), collect]).then(([exitCode]) => exitCode), timedOut]);
      if (outcome === 'timeout') {
        child.kill(TIMEOUT_KILL_SIGNAL);
        await reader.cancel();
        throw new Refused('timeout', 'agent.tool_not_allowed', `"${command}" did not finish within ${timeoutMs}ms.`);
      }
      const { text, truncated } = output.result();
      return { exitCode: outcome, output: text, truncated };
    } finally {
      clearTimeout(timer);
    }
  }

  const refuse = (tool: string, code: EnvToolRefusal['code'], reason: ShieldReasonCode, detail: string, key?: IdempotencyKey): EnvToolResult => {
    // A timeout is the process's doing, not a policy breach: refused, not reported.
    if (code !== 'timeout') deps.shield.report(reason, context, { agentId: agent.id, tool, detail, ...(key ? { idempotencyKey: idempotencyKeyString(key) } : {}) });
    return { ok: false, refusal: { code, tool, detail } };
  };

  return {
    mutates: ENV_TOOL_MUTATES,
    async call(tool, args, key) {
      if (!allowed.has(tool)) {
        return refuse(String(tool), 'tool-not-allowed', 'agent.tool_not_allowed', `"${String(tool)}" is not on agent "${agent.id}"'s allowlist.`, key);
      }
      if (ENV_TOOL_MUTATES[tool] && !key) {
        return refuse(tool, 'tool-not-allowed', 'agent.tool_not_allowed', `"${tool}" changes the environment and needs an idempotency key.`);
      }
      try {
        return { ok: true, result: await handlers[tool](argsRecord(args)) };
      } catch (error) {
        if (error instanceof Refused) return refuse(tool, error.code, error.reason, error.message, key);
        throw error;
      }
    },
  };
}
