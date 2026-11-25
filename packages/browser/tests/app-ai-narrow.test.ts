/** A child runtime's relay is never wider than its parent's: resource and model ceilings (contract §5). */
import { describe, expect, it } from 'vitest';
import { connectionSecretsUnfilled, narrowHostRelay, type AiForwardRequest, type HostRelay } from '../src/app.js';

const encoder = new TextEncoder();
const body = (model?: string) => encoder.encode(JSON.stringify(model ? { model } : {}));
const request = (resourceId: string, model?: string, models?: string[]): AiForwardRequest => ({ resourceId, body: body(model), stream: false, ...(models ? { models } : {}) });

function parent(): HostRelay & { calls: AiForwardRequest[] } {
  const calls: AiForwardRequest[] = [];
  return {
    calls,
    async *forwardAi(req) {
      calls.push(req);
      yield encoder.encode('ok');
    },
    connectionSecrets: connectionSecretsUnfilled,
  };
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of iterable) void chunk;
}

describe('narrowHostRelay', () => {
  it('refuses a resource outside the ceiling before the parent is called', async () => {
    const up = parent();
    const relay = narrowHostRelay(up, new Map([['chat', undefined]]));
    await expect(drain(relay.forwardAi(request('other')))).rejects.toThrow(/not available/);
    expect(up.calls).toHaveLength(0);
  });

  it('refuses a model outside the ceiling allowlist, and models outside it', async () => {
    const up = parent();
    const relay = narrowHostRelay(up, new Map([['chat', ['small']]]));
    await expect(drain(relay.forwardAi(request('chat', 'big')))).rejects.toThrow(/not allowed/);
    await expect(drain(relay.forwardAi(request('chat', 'small', ['small', 'big'])))).rejects.toThrow(/exceed/);
    expect(up.calls).toHaveLength(0);
  });

  it('forwards an allowed request and supplies the ceiling list when the request names none', async () => {
    const up = parent();
    const relay = narrowHostRelay(up, new Map([['chat', ['small']]]));
    await drain(relay.forwardAi(request('chat', 'small')));
    expect(up.calls[0]?.models).toEqual(['small']);
  });

  it('treats an empty ceiling list as no allowlist', async () => {
    const up = parent();
    const relay = narrowHostRelay(up, new Map([['chat', []]]));
    await drain(relay.forwardAi(request('chat', 'anything')));
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]?.models).toBeUndefined();
  });
});
