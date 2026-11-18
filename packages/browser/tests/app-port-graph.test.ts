/**
 * W10 control 4 wired through the application runtime: `startApplicationRuntime`
 * puts the app's `dependsOn` graph in force on the runtime's port policy on
 * `start()` (web → api → db: api may dial db, web may not) and removes it on
 * `stop()`.
 */
import { describe, expect, it } from 'vitest';
import { PortRegistry, textResponse, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { ServiceGraphPolicy } from '@seanhogg/builderforce-webcontainers-core/app';
import { startApplicationRuntime, type ApplicationSpec, type ServiceSpec } from '../src/app.js';
import { fakeProvider } from './app-fakeProvider.js';

const svc = (id: string, extra: Partial<ServiceSpec> = {}): ServiceSpec => ({ id, type: 'application', runtime: 'fake', command: 'run', ...extra });
const spec: ApplicationSpec = { projectId: 'graph', services: [svc('db'), svc('api', { dependsOn: ['db'] }), svc('web', { dependsOn: ['api'] })] };

describe('application runtime registers its service graph', () => {
  it('lets api dial db and refuses web, while the application runs', async () => {
    const policy = new ServiceGraphPolicy();
    const ports = new PortRegistry({ policy });
    const fake = fakeProvider({ autoReady: ['db', 'api', 'web'] });
    const runtime = startApplicationRuntime(spec, { providers: [fake.provider], runtime: { portPolicy: policy, killApplication: () => undefined }, stopTimeoutMs: 20, readinessTimeoutMs: 1000 });
    const as = (serviceId: string): SecurityContext => ({ applicationId: runtime.applicationId, serviceId });
    ports.listen(5432, async () => textResponse(502, ''), undefined, (socket) => socket.close(), as('db'));

    expect(ports.connect(5432, as('api'))).toBeUndefined(); // nothing registered before start
    await runtime.start();
    expect(policy.has(runtime.applicationId)).toBe(true);
    expect(ports.connect(5432, as('api'))).toBeDefined();
    expect(ports.connect(5432, as('web'))).toBeUndefined();

    await runtime.stop();
    expect(policy.has(runtime.applicationId)).toBe(false);
    expect(ports.connect(5432, as('api'))).toBeUndefined();
    await runtime.dispose();
  });
});
