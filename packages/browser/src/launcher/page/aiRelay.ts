/**
 * The launcher page's {@link HostRelay} (contract §6): `forwardAi` posts the
 * gateway's request to the launcher's token-gated `/__bf/ai` and yields the
 * answer as it arrives. The host callback behind that route attaches the
 * signed-in session; nothing here ever holds or returns a model credential.
 */
import { bodyChunks, connectionSecretsUnfilled, type AiForwardRequest, type HostRelay } from '../../app/hostRelay.js';
import { LAUNCH_PATHS, LAUNCH_TOKEN_HEADER, type AiRelayEnvelope } from '../protocol.js';
import { encodeBase64 } from './bootApplication.js';

export function launcherHostRelay(token: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): HostRelay {
  async function* forwardAi(request: AiForwardRequest): AsyncGenerator<Uint8Array> {
    const envelope: AiRelayEnvelope = {
      resourceId: request.resourceId,
      ...(request.models ? { models: [...request.models] } : {}),
      stream: request.stream,
      body: encodeBase64(request.body),
    };
    const response = await fetchImpl(LAUNCH_PATHS.ai, {
      method: 'POST',
      headers: { [LAUNCH_TOKEN_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(`AI relay answered ${response.status}`);
    if (!response.body) return;
    yield* bodyChunks(response.body);
  }
  return { forwardAi, connectionSecrets: connectionSecretsUnfilled };
}
