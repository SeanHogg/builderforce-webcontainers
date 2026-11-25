/**
 * `POST /__bf/ai` (contract §6): the host's model relay, on the page origin only.
 *
 * The page gateway sends the process's body and the host-read resource facts;
 * the host callback attaches the signed-in session and streams the completion
 * back. Upstream headers are never copied and no token is ever written. The
 * route sits behind the launch-token check and the Host allowlist of the
 * `/__bf` API; preview origins never reach it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AiForwardRequest } from '../../app/hostRelay.js';
import { MAX_AI_REQUEST_BYTES } from '../protocol.js';
import { readBoundedBody, sendText } from './httpResponses.js';
import { apiHeaders } from './previewHeaders.js';

/** Host-side forward: attaches the signed-in session, yields the upstream body as it arrives, never returns a token. */
export type LauncherForwardAi = (request: AiForwardRequest, signal: AbortSignal) => AsyncIterable<Uint8Array>;

const RESOURCE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/i;
const MAX_MODELS = 64;
const MAX_MODEL_LENGTH = 200;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The relay request an envelope describes, or the reason it is refused. */
export function parseAiRelayEnvelope(json: unknown): AiForwardRequest | string {
  if (typeof json !== 'object' || json === null) return 'The request is not a JSON object.';
  const { resourceId, models, stream, body } = json as Record<string, unknown>;
  if (typeof resourceId !== 'string' || !RESOURCE_ID.test(resourceId)) return 'resourceId is missing or malformed.';
  if (models !== undefined && (!Array.isArray(models) || models.length > MAX_MODELS || models.some((m) => typeof m !== 'string' || m.length > MAX_MODEL_LENGTH))) {
    return 'models must be a short array of model names.';
  }
  if (typeof stream !== 'boolean') return 'stream must be a boolean.';
  if (typeof body !== 'string' || !BASE64.test(body)) return 'body must be base64.';
  return {
    resourceId,
    ...(models && models.length > 0 ? { models: models as string[] } : {}),
    body: new Uint8Array(Buffer.from(body, 'base64')),
    stream,
  };
}

function refuse(req: IncomingMessage, res: ServerResponse, status: number, message: string): void {
  sendText(req, res, status, apiHeaders('text/plain; charset=utf-8'), message);
}

export async function serveAiRelay(req: IncomingMessage, res: ServerResponse, forwardAi: LauncherForwardAi): Promise<void> {
  if (req.method !== 'POST') return sendText(req, res, 405, { ...apiHeaders('text/plain; charset=utf-8'), Allow: 'POST' }, 'Method not allowed.');
  const raw = await readBoundedBody(req, MAX_AI_REQUEST_BYTES);
  if (raw === null) return refuse(req, res, 413, 'The request is too large.');
  let parsed: AiForwardRequest | string;
  try {
    parsed = parseAiRelayEnvelope(JSON.parse(raw.toString('utf8')));
  } catch {
    parsed = 'The request is not valid JSON.';
  }
  if (typeof parsed === 'string') return refuse(req, res, 400, parsed);
  const forward = parsed;

  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let iterator: AsyncIterator<Uint8Array>;
  let first: IteratorResult<Uint8Array>;
  try {
    iterator = forwardAi(forward, abort.signal)[Symbol.asyncIterator]();
    first = await iterator.next();
  } catch (error) {
    return refuse(req, res, 502, error instanceof Error ? error.message : 'The model relay failed.');
  }
  res.writeHead(200, apiHeaders(forward.stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'));
  try {
    for (let next = first; !next.done; next = await iterator.next()) {
      if (next.value.byteLength) res.write(next.value);
    }
    res.end();
  } catch {
    res.destroy(); // mid-stream: the page sees the body end in error; the launcher keeps serving
  }
}
