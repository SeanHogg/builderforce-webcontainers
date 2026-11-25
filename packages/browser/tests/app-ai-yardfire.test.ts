/** The Yardfire fixture (make.md W11 ai-resource): manifest → spec → gateway → streamed completion, with no credential in env. */
import { describe, expect, it } from 'vitest';
import { PortRegistry, type HttpRequestData } from '@seanhogg/builderforce-webcontainers-core';
import { ServiceGraphPolicy } from '@seanhogg/builderforce-webcontainers-core/app';
import { connectionSecretsUnfilled, parseManifest, startApplicationRuntime, toApplicationSpec, type ApplicationHost, type HostRelay } from '../src/app.js';
import { fakeProvider } from './app-fakeProvider.js';

const YARDFIRE = JSON.stringify({
  version: 1,
  name: 'yardfire',
  resources: { assistant: { type: 'ai', models: ['builderforce'] } },
  services: { api: { runtime: 'node', command: 'node server.js', role: 'backend', port: 8787, uses: ['assistant'] } },
  environments: { local: { target: 'browser', tier: 'non-production' } },
});
const SENTINEL_TOKEN = 'sk-sentinel-session-token';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Yardfire ai resource', () => {
  it('validates with no errors and maps to an ai resourceUse', () => {
    const parsed = parseManifest(YARDFIRE);
    expect(parsed.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const result = toApplicationSpec(parsed.manifest!, 'local', { projectId: 'yardfire' });
    expect(result.spec?.services.find((service) => service.id === 'api')?.resourceUses).toEqual([{ id: 'assistant', type: 'ai', models: ['builderforce'] }]);
  });

  it('streams a completion to api through AI_BASE_URL with no credential in env', async () => {
    const mapped = toApplicationSpec(parseManifest(YARDFIRE).manifest!, 'local', { projectId: 'yardfire' }).spec!;
    // The fake provider stands in for the node runtime; the services' ai uses are untouched.
    const spec = { ...mapped, services: mapped.services.map((service) => ({ ...service, runtime: 'fake' })) };
    const policy = new ServiceGraphPolicy();
    const ports = new PortRegistry({ policy });
    const host: ApplicationHost = { portPolicy: policy, killApplication: () => undefined, listenHttp: (port, handler, owner) => ports.listenExclusive(port, handler, owner!) };
    // The sentinel stands for the session the adapter holds host-side; it must never reach the process.
    const relay: HostRelay = {
      async *forwardAi() {
        void SENTINEL_TOKEN;
        yield encoder.encode('data: {"choices":[]}\n\n');
        yield encoder.encode('data: [DONE]\n\n');
      },
      connectionSecrets: connectionSecretsUnfilled,
    };
    const fake = fakeProvider({ autoReady: ['api'] });
    const runtime = startApplicationRuntime(spec, { providers: [fake.provider], runtime: host, hostRelay: relay, stopTimeoutMs: 20, readinessTimeoutMs: 1000 });
    await runtime.start();
    const env = fake.last('api').env;
    expect(env.AI_BASE_URL).toMatch(/^http:\/\/localhost:\d+\/v1$/);
    expect(Object.keys(env).filter((key) => /(_API_KEY|TOKEN|AUTHORIZATION)/i.test(key))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(SENTINEL_TOKEN);
    const request: HttpRequestData = { method: 'POST', url: '/v1/chat/completions', headers: {}, body: encoder.encode(JSON.stringify({ model: 'builderforce', stream: true })) };
    const response = await ports.request(Number(new URL(env.AI_BASE_URL!).port), request, { applicationId: runtime.applicationId, serviceId: 'api' });
    const reader = response!.body.getReader();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toBe('data: {"choices":[]}\n\ndata: [DONE]\n\n');
    expect(text).not.toContain(SENTINEL_TOKEN);
    await runtime.dispose();
  });
});
