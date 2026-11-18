/**
 * W10 control 4: port ownership and the service graph. Every port records its
 * owner; request / upgrade / connect are decided against the caller's
 * page-side identity and the application's declared `dependsOn` edges. A
 * refusal looks exactly like nothing listening.
 */
import { describe, expect, it } from 'vitest';
import { PortRegistry, type PortDecisionEvent } from '../../src/system/ports.js';
import { PLATFORM_CONTEXT, WORKSPACE_CONTEXT, type SecurityContext } from '../../src/system/securityContext.js';
import { textResponse } from '../../src/system/httpStream.js';
import { ServiceGraphPolicy } from '../../src/app/servicePortPolicy.js';
import type { ApplicationSpec } from '../../src/app/spec.js';

const spec: ApplicationSpec = {
  projectId: 'p',
  services: [
    { id: 'db', type: 'database', runtime: 'pglite', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
    { id: 'api', type: 'application', runtime: 'node', command: 'node', port: 8000, dependsOn: ['db'] },
    { id: 'worker', type: 'application', runtime: 'node', command: 'node', port: 8100 },
    { id: 'web', type: 'application', runtime: 'node', command: 'node', role: 'frontend', port: 3000, dependsOn: ['api'] },
  ],
};

const as = (applicationId: string, serviceId: string): SecurityContext => ({ applicationId, serviceId });
const request = { method: 'GET', url: '/', headers: {}, body: null };

function network() {
  const policy = new ServiceGraphPolicy();
  const decisions: PortDecisionEvent[] = [];
  const ports = new PortRegistry({ policy, onDecision: (event) => decisions.push(event) });
  const serve = (port: number, owner: SecurityContext) => ports.listen(port, async () => textResponse(200, 'ok'), undefined, (socket) => socket.close(), owner);
  return { policy, ports, decisions, serve };
}

describe('PortRegistry + ServiceGraphPolicy', () => {
  it('lets a service reach what it declares dependsOn, and its own ports', async () => {
    const { policy, ports, serve } = network();
    policy.register('a', spec);
    serve(8000, as('a', 'api'));
    serve(5432, as('a', 'db'));
    expect(ports.connect(5432, as('a', 'api'))).toBeDefined();
    expect(await ports.request(8000, request, as('a', 'web'))).toBeDefined();
    expect(await ports.request(8000, request, as('a', 'api'))).toBeDefined();
  });

  it('refuses an undeclared edge, like nothing listening (ECONNREFUSED / undefined)', async () => {
    const { policy, ports, decisions, serve } = network();
    policy.register('a', spec);
    serve(5432, as('a', 'db'));
    serve(8100, as('a', 'worker'));
    expect(ports.connect(5432, as('a', 'web'))).toBeUndefined(); // the frontend declared only api
    expect(ports.connect(5432, as('a', 'worker'))).toBeUndefined();
    expect(await ports.request(8100, request, as('a', 'api'))).toBeUndefined();
    expect(decisions.filter((event) => !event.decision.allow).map((event) => event.decision)).toEqual([
      { allow: false, reason: 'port.edge_not_declared' },
      { allow: false, reason: 'port.edge_not_declared' },
      { allow: false, reason: 'port.edge_not_declared' },
    ]);
  });

  it('refuses a dial into another application, even along a same-named edge', () => {
    const { policy, ports, decisions, serve } = network();
    policy.register('a', spec);
    policy.register('b', spec);
    serve(5432, as('a', 'db'));
    expect(ports.connect(5432, as('b', 'api'))).toBeUndefined();
    expect(decisions.at(-1)?.decision).toEqual({ allow: false, reason: 'port.not_owner' });
  });

  it('keeps application code off workspace and platform ports, and off everything once unregistered', () => {
    const { policy, ports, serve } = network();
    const unregister = policy.register('a', spec);
    serve(7000, WORKSPACE_CONTEXT);
    ports.listen(7001, async () => textResponse(200, 'host')); // no owner: the platform's
    serve(8000, as('a', 'api'));
    expect(ports.ownerOf(7001)).toEqual(PLATFORM_CONTEXT);
    expect(ports.connect(7000, as('a', 'api'))).toBeUndefined();
    expect(ports.connect(7001, as('a', 'api'))).toBeUndefined();
    expect(ports.connect(8000, as('a', 'web'))).toBeDefined();
    unregister();
    expect(ports.connect(8000, as('a', 'web'))).toBeUndefined();
  });

  it('lets the platform (the default caller) and the workspace reach any port', async () => {
    const { ports, serve } = network();
    serve(8000, as('a', 'api'));
    expect(await ports.request(8000, request)).toBeDefined();
    expect(ports.connect(8000, WORKSPACE_CONTEXT)).toBeDefined();
  });

  it('hands the caller to the listener, fails closed when the policy throws, and survives a throwing telemetry hook', () => {
    const callers: Array<SecurityContext | undefined> = [];
    const ports = new PortRegistry({ onDecision: () => { throw new Error('sink down'); } });
    ports.listen(9000, async () => textResponse(200, ''), undefined, (_socket, caller) => callers.push(caller), WORKSPACE_CONTEXT);
    expect(ports.connect(9000, WORKSPACE_CONTEXT)).toBeDefined();
    expect(callers).toEqual([WORKSPACE_CONTEXT]);
    const broken = new PortRegistry({ policy: { decide: () => { throw new Error('policy crashed'); } } });
    broken.listen(9001, async () => textResponse(200, ''));
    expect(broken.connect(9001)).toBeUndefined();
  });

  it('refuses reserved or duplicate application ids and invalid graphs', () => {
    const policy = new ServiceGraphPolicy();
    expect(() => policy.register('workspace', spec)).toThrow('reserved');
    expect(() => policy.register('platform', spec)).toThrow('reserved');
    policy.register('a', spec);
    expect(() => policy.register('a', spec)).toThrow('already registered');
    expect(() => policy.register('c', { projectId: 'p', services: [{ id: 'x', type: 'application', runtime: 'node', dependsOn: ['nope'] }] })).toThrow();
  });
});
