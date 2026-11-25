/**
 * Host-delivered AI through `startApplicationRuntime` (contract §5): one
 * exclusive port per backend `ai` use, `AI_BASE_URL` in that service's env, the
 * completion streamed with secret headers stripped, and the port closed on dispose.
 */
import { describe, expect, it } from 'vitest';
import { PortRegistry, type HttpRequestData, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { ServiceGraphPolicy } from '@seanhogg/builderforce-webcontainers-core/app';
import { startApplicationRuntime, connectionSecretsUnfilled, type AiForwardRequest, type ApplicationHost, type ApplicationSpec, type HostRelay, type ServiceSpec } from '../src/app.js';
import { fakeProvider } from './app-fakeProvider.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const use = (id: string, models?: string[]) => ({ id, type: 'ai' as const, ...(models ? { models } : {}) });
const post = (body: unknown): HttpRequestData => ({ method: 'POST', url: '/v1/chat/completions', headers: {}, body: encoder.encode(JSON.stringify(body)) });

function fixture(spec: ApplicationSpec, relay?: HostRelay, withListenHttp = true) {
  const policy = new ServiceGraphPolicy();
  const ports = new PortRegistry({ policy });
  const host: ApplicationHost = {
    portPolicy: policy,
    killApplication: () => undefined,
    ...(withListenHttp ? { listenHttp: (port, handler, owner) => ports.listenExclusive(port, handler, owner!) } : {}),
  };
  const fake = fakeProvider({ autoReady: spec.services.map((s) => s.id) });
  const runtime = startApplicationRuntime(spec, { providers: [fake.provider], runtime: host, hostRelay: relay, stopTimeoutMs: 20, readinessTimeoutMs: 1000 });
  const as = (serviceId: string): SecurityContext => ({ applicationId: runtime.applicationId, serviceId });
  return { ports, fake, runtime, as };
}

function relayOf(forward: (request: AiForwardRequest) => AsyncIterable<Uint8Array>): HostRelay & { calls: AiForwardRequest[] } {
  const calls: AiForwardRequest[] = [];
  return {
    calls,
    forwardAi(request) {
      calls.push(request);
      return forward(request);
    },
    connectionSecrets: connectionSecretsUnfilled,
  };
}

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield encoder.encode(part);
}

const one: ApplicationSpec = { projectId: 'ai', services: [svc('api', { resourceUses: [use('chat')] }), svc('web', { role: 'frontend', dependsOn: ['api'], resourceUses: [use('chat')] })] };
const portOf = (env: Record<string, string>) => Number(new URL(env.AI_BASE_URL!).port);

async function read(response: { body: ReadableStream<Uint8Array> }): Promise<string> {
  const reader = response.body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

describe('AI gateway through startApplicationRuntime', () => {
  it('sets AI_BASE_URL (no trailing slash) for a backend and nothing for a frontend', async () => {
    const { runtime, fake } = fixture(one, relayOf(() => chunks('x')));
    await runtime.start();
    expect(fake.last('api').env.AI_BASE_URL).toMatch(/^http:\/\/localhost:\d+\/v1$/);
    expect(fake.last('web').env.AI_BASE_URL).toBeUndefined();
    expect(fake.last('web').env.CHAT_AI_BASE_URL).toBeUndefined();
    await runtime.dispose();
  });

  it('names each base URL by resource when there are two, and sets no AI_BASE_URL', async () => {
    const spec: ApplicationSpec = { projectId: 'ai2', services: [svc('api', { resourceUses: [use('chat'), use('embed')] })] };
    const { runtime, fake } = fixture(spec, relayOf(() => chunks('x')));
    await runtime.start();
    const env = fake.last('api').env;
    expect(env.CHAT_AI_BASE_URL).toMatch(/\/v1$/);
    expect(env.EMBED_AI_BASE_URL).toMatch(/\/v1$/);
    expect(env.CHAT_AI_BASE_URL).not.toBe(env.EMBED_AI_BASE_URL);
    expect(env.AI_BASE_URL).toBeUndefined();
    await runtime.dispose();
  });

  it('sets nothing, and never listens, without a relay or without listenHttp', async () => {
    const noRelay = fixture(one);
    await noRelay.runtime.start();
    expect(noRelay.fake.last('api').env.AI_BASE_URL).toBeUndefined();
    expect(noRelay.ports.ports()).toEqual([]);
    await noRelay.runtime.dispose();
    const noListen = fixture(one, relayOf(() => chunks('x')), false);
    await noListen.runtime.start();
    expect(noListen.fake.last('api').env.AI_BASE_URL).toBeUndefined();
    await noListen.runtime.dispose();
  });

  it('streams the relay body and never writes secret headers', async () => {
    const relay = relayOf(() => chunks('data: a\n\n', 'data: b\n\n'));
    const { runtime, fake, ports, as } = fixture(one, relay);
    await runtime.start();
    const response = await ports.request(portOf(fake.last('api').env), post({ model: 'm', stream: true }), as('api'));
    expect(response?.status).toBe(200);
    expect(await read(response!)).toBe('data: a\n\ndata: b\n\n');
    const names = Object.keys(response!.headers).map((name) => name.toLowerCase());
    for (const name of ['set-cookie', 'authorization', 'www-authenticate']) expect(names).not.toContain(name);
    expect(relay.calls[0]).toMatchObject({ resourceId: 'chat', stream: true });
    await runtime.dispose();
  });

  it('refuses a model outside the allowlist with 400 before the relay is called', async () => {
    const restricted: ApplicationSpec = { projectId: 'ai3', services: [svc('api', { resourceUses: [use('chat', ['allowed'])] })] };
    const relay = relayOf(() => chunks('ok'));
    const { runtime, fake, ports, as } = fixture(restricted, relay);
    await runtime.start();
    const port = portOf(fake.last('api').env);
    expect((await ports.request(port, post({ model: 'other' }), as('api')))?.status).toBe(400);
    expect(relay.calls).toHaveLength(0);
    expect((await ports.request(port, post({ model: 'allowed' }), as('api')))?.status).toBe(200);
    await runtime.dispose();
  });

  it('forwards any model when the allowlist is empty', async () => {
    const open: ApplicationSpec = { projectId: 'ai4', services: [svc('api', { resourceUses: [use('chat', [])] })] };
    const { runtime, fake, ports, as } = fixture(open, relayOf(() => chunks('ok')));
    await runtime.start();
    expect((await ports.request(portOf(fake.last('api').env), post({ model: 'any' }), as('api')))?.status).toBe(200);
    await runtime.dispose();
  });

  it('answers 502 when the relay fails on the first chunk, and keeps serving', async () => {
    let fail = true;
    const relay = relayOf(async function* () {
      if (fail) throw new Error('upstream down');
      yield encoder.encode('fine');
    });
    const { runtime, fake, ports, as } = fixture(one, relay);
    await runtime.start();
    const port = portOf(fake.last('api').env);
    expect((await ports.request(port, post({ model: 'm' }), as('api')))?.status).toBe(502);
    fail = false;
    expect(await read((await ports.request(port, post({ model: 'm' }), as('api')))!)).toBe('fine');
    await runtime.dispose();
  });

  it('is reachable by its owner only: not a dependent, not the platform', async () => {
    const { runtime, fake, ports, as } = fixture(one, relayOf(() => chunks('x')));
    await runtime.start();
    const port = portOf(fake.last('api').env);
    expect(ports.reaches(port, as('api'))).toBe(true);
    expect(ports.reaches(port, as('web'))).toBe(false);
    expect(await ports.request(port, post({ model: 'm' }), as('web'))).toBeUndefined();
    expect(await ports.request(port, post({ model: 'm' }))).toBeUndefined();
    await runtime.dispose();
  });

  it('closes the port on dispose', async () => {
    const { runtime, fake, ports } = fixture(one, relayOf(() => chunks('x')));
    await runtime.start();
    const port = portOf(fake.last('api').env);
    expect(ports.has(port)).toBe(true);
    await runtime.dispose();
    expect(ports.has(port)).toBe(false);
  });
});
