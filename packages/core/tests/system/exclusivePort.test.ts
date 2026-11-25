/** An exclusive port (the AI gateway, contract §5) is reachable by its owner service alone. */
import { describe, expect, it } from 'vitest';
import { PortRegistry } from '../../src/system/ports.js';
import { PLATFORM_CONTEXT, WORKSPACE_CONTEXT, type SecurityContext } from '../../src/system/securityContext.js';
import { textResponse } from '../../src/system/httpStream.js';
import { ServiceGraphPolicy } from '../../src/app/servicePortPolicy.js';
import type { ApplicationSpec } from '../../src/app/spec.js';

const spec: ApplicationSpec = {
  projectId: 'p',
  services: [
    { id: 'api', type: 'application', runtime: 'node', command: 'node', port: 8000 },
    { id: 'web', type: 'application', runtime: 'node', command: 'node', role: 'frontend', port: 3000, dependsOn: ['api'] },
  ],
};
const as = (applicationId: string, serviceId: string): SecurityContext => ({ applicationId, serviceId });
const request = { method: 'POST', url: '/v1/chat/completions', headers: {}, body: null };

function gateway() {
  const policy = new ServiceGraphPolicy();
  policy.register('a', spec);
  policy.register('b', spec);
  const ports = new PortRegistry({ policy });
  const registration = ports.listenExclusive(0, async () => textResponse(200, 'ok'), as('a', 'api'));
  return { ports, registration };
}

describe('PortRegistry.listenExclusive', () => {
  it('admits the owning service only', async () => {
    const { ports, registration } = gateway();
    expect(await ports.request(registration.port, request, as('a', 'api'))).toBeDefined();
    expect(ports.connect(registration.port, as('a', 'api'))).toBeDefined();
  });

  it('refuses a dependsOn dependent, the platform, the workspace and another application', async () => {
    const { ports, registration } = gateway();
    for (const caller of [as('a', 'web'), PLATFORM_CONTEXT, WORKSPACE_CONTEXT, as('b', 'api')]) {
      expect(await ports.request(registration.port, request, caller), JSON.stringify(caller)).toBeUndefined();
      expect(ports.connect(registration.port, caller)).toBeUndefined();
      expect(ports.reaches(registration.port, caller)).toBe(false);
    }
  });

  it('lists the port for its owner only', () => {
    const { ports, registration } = gateway();
    expect(ports.reachablePorts(as('a', 'api'))).toContain(registration.port);
    expect(ports.reachablePorts(as('a', 'web'))).not.toContain(registration.port);
  });

  it('close clears the flag and frees the port', () => {
    const { ports, registration } = gateway();
    expect(ports.isExclusive(registration.port)).toBe(true);
    registration.close();
    expect(ports.isExclusive(registration.port)).toBe(false);
    expect(ports.has(registration.port)).toBe(false);
  });

  it('leaves a plain listen unchanged: a dependent still reaches it', async () => {
    const policy = new ServiceGraphPolicy();
    policy.register('a', spec);
    const ports = new PortRegistry({ policy });
    ports.listen(8000, async () => textResponse(200, 'ok'), undefined, undefined, as('a', 'api'));
    expect(await ports.request(8000, request, as('a', 'web'))).toBeDefined();
    expect(ports.isExclusive(8000)).toBe(false);
  });
});
