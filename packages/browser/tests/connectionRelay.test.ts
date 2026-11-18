/**
 * W10 control 4 at the relay: a process's dial is decided as the identity the
 * PAGE bound to the relay for that Worker — never anything in the dial message,
 * which the Worker writes and can forge.
 */
import { describe, expect, it } from 'vitest';
import { PortRegistry, textResponse, WORKSPACE_CONTEXT, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { ServiceGraphPolicy, type ApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { ConnectionRelay } from '../src/node/connectionRelay.js';
import type { HostToWorker, WorkerToHost } from '../src/node/protocol.js';

const spec: ApplicationSpec = {
  projectId: 'p',
  services: [
    { id: 'db', type: 'database', runtime: 'pglite', port: 5432, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
    { id: 'api', type: 'application', runtime: 'node', command: 'node', dependsOn: ['db'] },
    { id: 'web', type: 'application', runtime: 'node', command: 'node', role: 'frontend' },
  ],
};
const as = (applicationId: string, serviceId: string): SecurityContext => ({ applicationId, serviceId });

function setup() {
  const policy = new ServiceGraphPolicy();
  policy.register('a', spec);
  policy.register('b', spec);
  const ports = new PortRegistry({ policy });
  const callers: Array<SecurityContext | undefined> = [];
  ports.listen(5432, async () => textResponse(502, ''), undefined, (_socket, caller) => callers.push(caller), as('a', 'db'));
  const identities = new Map<number, SecurityContext>([[10, as('a', 'api')], [20, as('a', 'web')], [30, as('b', 'api')]]);
  const relayFor = (pid: number) => {
    const posted: HostToWorker[] = [];
    const relay = new ConnectionRelay(ports, (message) => posted.push(message), { pid, identityOf: (of) => identities.get(of) });
    const dial = (extra: Record<string, unknown> = {}) => {
      relay.receive({ type: 'dial', connId: 1, port: 5432, ...extra } as Extract<WorkerToHost, { type: 'dial' }>);
      return posted.find((message) => message.type === 'dial-result') as { ok: boolean } | undefined;
    };
    return { dial };
  };
  return { relayFor, callers, identities };
}

describe('ConnectionRelay dial identity', () => {
  it('lets a process dial along its declared edge, as its bound identity', () => {
    const { relayFor, callers } = setup();
    expect(relayFor(10).dial()?.ok).toBe(true);
    expect(callers).toEqual([as('a', 'api')]);
  });

  it("ignores a pid or application the Worker writes into its dial message: an undeclared edge stays refused", () => {
    const { relayFor, callers } = setup();
    // The frontend's Worker claims to be the api process (pid 10) of app a.
    expect(relayFor(20).dial({ pid: 10, applicationId: 'a', serviceId: 'api', caller: as('a', 'api') })?.ok).toBe(false);
    // Another application's api claims app a's.
    expect(relayFor(30).dial({ pid: 10, applicationId: 'a' })?.ok).toBe(false);
    expect(callers).toEqual([]);
    // And a legitimate process claiming to be someone else is still itself.
    expect(relayFor(10).dial({ pid: 30, applicationId: 'b' })?.ok).toBe(true);
    expect(callers).toEqual([as('a', 'api')]);
  });

  it('refuses every dial from a process the page does not know (exited, never spawned)', () => {
    const { relayFor, identities } = setup();
    expect(relayFor(99).dial()?.ok).toBe(false);
    identities.delete(10); // it exited
    expect(relayFor(10).dial()?.ok).toBe(false);
  });

  it('without a bound identity, a process is the workspace', () => {
    const ports = new PortRegistry();
    const callers: Array<SecurityContext | undefined> = [];
    ports.listen(7000, async () => textResponse(502, ''), undefined, (_socket, caller) => callers.push(caller));
    const posted: HostToWorker[] = [];
    new ConnectionRelay(ports, (message) => posted.push(message)).receive({ type: 'dial', connId: 1, port: 7000 } as Extract<WorkerToHost, { type: 'dial' }>);
    expect(callers).toEqual([WORKSPACE_CONTEXT]);
  });
});
