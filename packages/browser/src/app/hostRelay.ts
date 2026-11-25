/**
 * Host-held session relay for host-delivered resources (app-manifest `ai`,
 * contract §5–§6). An in-process function the launcher passes into
 * `startApplicationRuntime` — never a `postMessage` listener, never serialized
 * onto the launch URL.
 *
 * The page gateway is the only caller of `forwardAi`. Adapters attach the
 * signed-in session on the way out and never return a token to the process.
 *
 * `connectionSecrets` is the vault seam for ticket #6999. This pass declares it
 * and does not fill it: web and VSIX adapters reject, and no vault field names
 * are invented here.
 */
import { modelAllowed } from './aiGateway.js';

export interface AiForwardRequest {
  /** The `ai` resource id from the host-read launch spec, never from process bytes. */
  resourceId: string;
  /**
   * Allowlist from the host-read launch spec (`resourceUses[].models`). Absent:
   * the API gateway's existing cascade router decides. Never taken from the
   * process request.
   */
  models?: readonly string[];
  /** The process's request body (`POST /v1/chat/completions`), with no headers. */
  body: Uint8Array;
  /** True when the process asked for a streamed completion. Do not buffer it. */
  stream: boolean;
}

export interface HostRelay {
  /**
   * OpenAI-compatible forward to `POST /v1/chat/completions` on the API host.
   * The host adds the signed-in session. Never returns a token. Yields the
   * upstream body (SSE or JSON) as it arrives — the page gateway builds the
   * process response and strips `Set-Cookie` / `Authorization` /
   * `WWW-Authenticate` before any byte is written back.
   */
  forwardAi(req: AiForwardRequest): AsyncIterable<Uint8Array>;
  /**
   * Vault material for one Connected Account. Host-side only; used by the
   * connection relay (#6999), never returned to the process. Not filled this
   * pass — adapters reject rather than invent vault field names.
   */
  connectionSecrets(connectionId: string): Promise<Record<string, string>>;
}

/** #6999 owns the vault fill. Adapters use this so a call fails closed. */
export function connectionSecretsUnfilled(_connectionId: string): Promise<Record<string, string>> {
  return Promise.reject(new Error('Connection vault delivery is not implemented (ticket #6999).'));
}

/** Yield a response body as it arrives; cancel it if the consumer stops early (the meter must stop too). */
export async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      yield value;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined); // error-logging: the consumer already left; nothing to report to
    reader.releaseLock();
  }
}

/** Ceiling for a child: resourceId → its model allowlist (undefined = any). */
export type AiCeiling = ReadonlyMap<string, readonly string[] | undefined>;

/**
 * A relay no wider than `parent`'s: a resource outside `ceiling`, or a model
 * list outside its allowlist, is refused before the parent is called.
 * `models: []` is an absent allowlist, as in the gateway.
 */
export function narrowHostRelay(parent: HostRelay, ceiling: AiCeiling): HostRelay {
  return {
    async *forwardAi(req) {
      if (!ceiling.has(req.resourceId)) throw new Error(`AI resource "${req.resourceId}" is not available to this runtime.`);
      const allowed = ceiling.get(req.resourceId);
      const limit = allowed && allowed.length > 0 ? allowed : undefined;
      if (limit) {
        if (req.models && req.models.length > 0 && !req.models.every((model) => limit.includes(model))) {
          throw new Error(`AI models for "${req.resourceId}" exceed this runtime's allowlist.`);
        }
        const verdict = modelAllowed(req.body, limit);
        if (!verdict.ok) throw new Error(verdict.message);
      }
      yield* parent.forwardAi({ ...req, ...(limit ? { models: req.models && req.models.length > 0 ? req.models : limit } : {}) });
    },
    connectionSecrets: connectionSecretsUnfilled,
  };
}
