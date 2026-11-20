import { describe, expect, it, vi } from 'vitest';
import { PortCookieJars, textResponse, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import type { ApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import { attachPreview } from '../src/previewAttach.js';
import { createPreviewIngress } from '../src/previewIngress.js';
import type { RequestOrigin, WireIngress, WireResponse } from '../src/protocol.js';
import type { PreviewTransport } from '../src/transport.js';
import { host } from './helpers.js';
import { startApplicationRuntime, type ApplicationHost } from '../src/app.js';
import { fakeProvider, stubRuntime } from './app-fakeProvider.js';

const APP = 'app:proj:0123456789abcdef';
const as = (serviceId: string, applicationId = APP): SecurityContext => Object.freeze({ applicationId, serviceId });

/** web (5173, frontend) → api (8000), routed `/api` → api and `/` → web. `webDependsOnApi: false` drops the edge. */
function spec(webDependsOnApi = true): ApplicationSpec {
  return {
    projectId: 'proj',
    services: [
      { id: 'api', type: 'application', runtime: 'node', command: 'node', root: '/api', port: 8000 },
      { id: 'web', type: 'application', runtime: 'node', command: 'npm', role: 'frontend', root: '/web', port: 5173, ...(webDependsOnApi ? { dependsOn: ['api'] } : {}) },
    ],
    ingress: { routes: [ { path: '/api', serviceId: 'api' }, { path: '/', serviceId: 'web' } ] },
  };
}

const OTHER = 'app:other:1';
const owners = new Map<number, SecurityContext>([
  [8000, as('api')],
  [5173, as('web')],
  [3000, as('workspace', 'workspace')],
  [9000, as('api', OTHER)],
]);

describe('previewIngress', () => {
  it('serves an application’s table on its own origin; the shared origin only the live handoff’s, or an application sharing it', () => {
    let handedOff: string | undefined;
    let sharing = false;
    const ingress = createPreviewIngress({ ownerOf: () => undefined, handoffApplication: () => handedOff, onSharedOrigin: () => sharing });
    const shared = ingress.view(undefined);
    const own = ingress.view(APP);
    const changes = vi.fn();
    shared.onChange(changes);
    const unregister = ingress.register(APP, spec());
    ingress.register(OTHER, spec());
    expect(own.routes()).toEqual([ { path: '/api', port: 8000 }, { path: '/', port: 5173 } ]);
    // Per-application origins: the shared origin serves no application's table — never "the latest registered".
    expect(shared.routes()).toEqual([]);
    handedOff = APP;
    expect(shared.routes()).toEqual(own.routes());
    handedOff = undefined;
    sharing = true; // the named opt-out: applications are served on the shared origin
    expect(shared.routes()).toEqual(own.routes());
    expect(ingress.view('app:none:1').routes()).toEqual([]);
    unregister();
    unregister();
    ingress.refresh();
    expect(changes).toHaveBeenCalledTimes(4); // two registrations, one unregister, one refresh
  });

  describe('decide: the origin check first, ingress only narrows', () => {
    const admitted = () => true;
    const refusedByOrigin = () => false;

    it('on an application’s own origin, acts as the page’s service or the frontend, only once the origin admits it', () => {
      const ingress = createPreviewIngress({ ownerOf: (port) => owners.get(port) });
      ingress.register(APP, spec());
      const view = ingress.view(APP);
      expect(view.decide(8000, { port: 5173, ingress: true }, admitted)).toEqual({ caller: as('web') });
      expect(view.decide(8000, { ingress: true }, admitted)).toEqual({ caller: as('web') });
      expect(view.decide(8000, { port: 8000 }, admitted)).toEqual({ caller: as('api') });
      expect(view.decide(8000, { port: 5173, ingress: true }, refusedByOrigin)).toBeNull();
      expect(view.decide(8000, { port: 3000, ingress: true }, admitted)).toBeNull(); // a workspace page never becomes the frontend
      expect(view.decide(8000, { port: 9000 }, admitted)).toEqual({ caller: as('api', OTHER) }); // another application's page stays its own (the registry refuses it)
      expect(view.decide(3000, { port: 5173 }, admitted)).toEqual({}); // not the application's port: by origin, as before
      expect(view.decide(3000, { port: 5173, ingress: true }, admitted)).toBeNull();
    });

    it('on the shared origin, a dev-server document is never the frontend without the application’s live handoff', () => {
      let handedOff: string | undefined;
      const ingress = createPreviewIngress({ ownerOf: (port) => owners.get(port), handoffApplication: () => handedOff, onSharedOrigin: () => true });
      ingress.register(APP, spec());
      const view = ingress.view(undefined);
      // The workspace's instant preview (no handoff, or a workspace process's): no frontend identity.
      expect(view.decide(8000, { ingress: true }, admitted)).toBeNull();
      expect(view.decide(8000, {}, admitted)).toEqual({}); // a direct request: by origin, as before ingress
      expect(view.decide(8000, {}, refusedByOrigin)).toBeNull();
      handedOff = APP;
      expect(view.decide(8000, { ingress: true }, refusedByOrigin)).toEqual({ caller: as('web') });
      // Even then, a workspace server's page and another application's port get nothing from the handoff.
      expect(view.decide(8000, { port: 3000, ingress: true }, refusedByOrigin)).toBeNull();
      expect(view.decide(9000, { ingress: true }, refusedByOrigin)).toBeNull();
      expect(view.decide(9000, {}, refusedByOrigin)).toBeNull();
    });
  });
});

describe('startApplicationRuntime and ingress', () => {
  it('registers the spec’s ingress under the minted application id on start, and unregisters it on stop', async () => {
    const fake = fakeProvider({ autoReady: ['api', 'web'] });
    const registered: string[] = [];
    let unregistered = 0;
    const runtime: ApplicationHost = {
      ...stubRuntime(),
      registerIngress(applicationId, registeredSpec) {
        registered.push(applicationId);
        expect(registeredSpec.ingress?.routes).toHaveLength(2);
        return () => void unregistered++;
      },
    };
    const fakeSpec: ApplicationSpec = { ...spec(), services: spec().services.map((service) => ({ ...service, runtime: 'fake' })) };
    const application = startApplicationRuntime(fakeSpec, { providers: [fake.provider], runtime, stopTimeoutMs: 20 });
    await application.start();
    expect(registered).toEqual([application.applicationId]);
    await application.stop();
    expect(unregistered).toBe(1);
    await application.dispose();
  });
});

/** A transport keeping each attach's worker end. */
function recordingTransport() {
  const ports: MessagePort[] = [];
  let reattach: ((id: string) => void) | undefined;
  const transport: PreviewTransport = {
    origin: 'https://app.preview.test',
    scope: '/__bfwc/',
    attach: (_id, port) => void ports.push(port),
    onReattach(listener) {
      reattach = listener;
      return () => (reattach = undefined);
    },
    send: vi.fn(),
    dispose: vi.fn(),
  };
  return { transport, ports, reattach: (id: string) => reattach?.(id) };
}

/** The worker end: every message the host posts, and a request/answer helper. */
function workerEnd(port: MessagePort) {
  const tables: WireIngress[] = [];
  let answer: ((response: WireResponse) => void) | undefined;
  port.onmessage = (event) => {
    const data = event.data as { type: string };
    if (data.type === 'ingress') tables.push(data as WireIngress);
    else if (data.type === 'response') answer?.(data as WireResponse);
  };
  let reqId = 0;
  const ask = (path: string, from?: RequestOrigin) =>
    new Promise<WireResponse>((resolve) => {
      answer = resolve;
      port.postMessage({ type: 'request', reqId: ++reqId, path, search: '', method: 'GET', headers: {}, body: null, ...(from ? { from } : {}) });
    });
  return { tables, ask };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A runtime with per-application origins: APP (api 8000, web 5173), OTHER (api 9000) and a workspace server (3000).
 * `origin`: which origin's attach this is — the shared one (it admits only the workspace's port) or APP's own (only APP's ports).
 * `handoff`: the application whose attributed process announced the live dev-server handoff.
 */
function ingressHost(webDependsOnApi = true, origin: 'shared' | 'own' = 'shared') {
  const { processes } = host();
  const state: { handoff?: string } = {};
  const ingress = createPreviewIngress({ ownerOf: (port) => processes.ports.ownerOf(port), handoffApplication: () => state.handoff, onSharedOrigin: () => false });
  const unregisterGraph = processes.portPolicy.register(APP, spec(webDependsOnApi));
  const unregisterOther = processes.portPolicy.register(OTHER, { projectId: 'other', services: [{ id: 'api', type: 'application', runtime: 'node', command: 'node', port: 9000 }] });
  processes.ports.listen(8000, async (request) => textResponse(200, `api ${request.url}`), undefined, undefined, as('api'));
  processes.ports.listen(5173, async (request) => textResponse(200, `web ${request.url}`), undefined, undefined, as('web'));
  processes.ports.listen(9000, async (request) => textResponse(200, `other ${request.url}`), undefined, undefined, as('api', OTHER));
  processes.ports.listen(3000, async () => textResponse(200, 'workspace'), undefined, undefined, as('workspace', 'workspace'));
  const { transport, ports, reattach } = recordingTransport();
  const mayServePort = vi.fn((port: number) => (origin === 'shared' ? port === 3000 : port === 8000 || port === 5173));
  const stop = attachPreview({ transport, id: 'p1', processes, cookies: new PortCookieJars(), scripts: () => [], bridgeNonce: 'b', mayServePort, ingress: ingress.view(origin === 'shared' ? undefined : APP) });
  const dispose = () => {
    stop();
    unregisterGraph();
    unregisterOther();
    processes.dispose();
  };
  return { ingress, ports, reattach, mayServePort, state, dispose };
}

const bodyText = (response: WireResponse) => (typeof response.body === 'string' ? response.body : '');

/** A streamed answer's body, gathered from its chunks. */
function streamed(port: MessagePort, response: WireResponse): Promise<string> {
  if (!response.streaming) return Promise.resolve(bodyText(response));
  return new Promise((resolve) => {
    let text = '';
    const decoder = new TextDecoder();
    const previous = port.onmessage;
    port.onmessage = (event) => {
      const data = event.data as { type: string; data?: ArrayBuffer };
      if (data.type === 'chunk') text += decoder.decode(data.data);
      else if (data.type === 'end') {
        port.onmessage = previous;
        resolve(text);
      }
    };
  });
}

describe('attaching a preview with ingress', () => {
  it('sends the table on every attach and whenever it changes', async () => {
    const { ingress, ports, reattach, state, dispose } = ingressHost();
    state.handoff = APP;
    const first = workerEnd(ports[0]!);
    await tick();
    expect(first.tables).toEqual([{ type: 'ingress', routes: [] }]);
    const unregister = ingress.register(APP, spec());
    await tick();
    expect(first.tables.at(-1)).toEqual({ type: 'ingress', routes: [ { path: '/api', port: 8000 }, { path: '/', port: 5173 } ] });
    reattach('p1');
    const second = workerEnd(ports[1]!);
    await tick();
    expect(second.tables).toEqual([first.tables.at(-1)]);
    unregister();
    await tick();
    expect(second.tables.at(-1)).toEqual({ type: 'ingress', routes: [] });
    dispose();
  });

  it('the live handoff’s frontend document reaches its api through /api along a declared edge — and nothing of another application', async () => {
    const allowed = ingressHost(true);
    allowed.state.handoff = APP;
    allowed.ingress.register(APP, spec(true));
    allowed.ingress.register(OTHER, spec(true));
    const worker = workerEnd(allowed.ports[0]!);
    const ok = await worker.ask('/__port/8000/api/items', { ingress: true });
    expect(ok.status).toBe(200);
    expect(await streamed(allowed.ports[0]!, ok)).toBe('api /api/items');
    // Another application's port: refused by ingress and directly.
    expect((await worker.ask('/__port/9000/items', { ingress: true })).status).toBe(403);
    expect((await worker.ask('/__port/9000/items', {})).status).toBe(403);
    allowed.dispose();

    const refused = ingressHost(false);
    refused.state.handoff = APP;
    refused.ingress.register(APP, spec(false));
    const end = workerEnd(refused.ports[0]!);
    const denied = await end.ask('/__port/8000/api/items', { ingress: true });
    expect(denied.status).toBe(502); // no declared edge: the registry's refusal looks like nothing listening
    refused.dispose();
  });

  it('with per-application origins, a shared-origin page that is not the live handoff’s frontend is refused an application port (H1)', async () => {
    const { ingress, ports, state, mayServePort, dispose } = ingressHost(true);
    ingress.register(APP, spec(true));
    const worker = workerEnd(ports[0]!);
    const refusedBoth = async (from: RequestOrigin) => {
      expect((await worker.ask('/__port/8000/api/items', { ...from, ingress: true })).status).toBe(403); // via ingress
      expect((await worker.ask('/__port/8000/api/items', from)).status).toBe(403); // direct `/__bfwc/<id>/__port/8000/…` (the worker strips the prefix)
    };
    // The workspace's instant preview (no handoff), a terminal-started workspace server's page, another application's page.
    await refusedBoth({});
    await refusedBoth({ port: 3000 });
    await refusedBoth({ port: 9000 });
    // A handoff by ANOTHER application binds the shared origin to that one: APP's ports stay out of reach.
    state.handoff = OTHER;
    await refusedBoth({});
    // APP's handoff grants its frontend document only: the workspace server's page still gets nothing.
    state.handoff = APP;
    await refusedBoth({ port: 3000 });
    expect(mayServePort).toHaveBeenCalled(); // the origin check is never skipped for them
    dispose();
  });

  it('on an application’s own origin, the page acts as its own service after the origin admits it', async () => {
    const { ingress, ports, dispose } = ingressHost(false, 'own');
    ingress.register(APP, spec(false));
    const worker = workerEnd(ports[0]!);
    expect((await worker.ask('/__port/5173/style.css', { ingress: true, port: 5173 })).status).toBe(200); // web's page reaching web
    expect((await worker.ask('/__port/8000/api', { ingress: true, port: 5173 })).status).toBe(502); // no web → api edge
    expect((await worker.ask('/__port/9000/', { port: 5173 })).status).toBe(403); // another application's port: the origin refuses
    dispose();
  });

  it('refuses an ingress-routed request no application claims, and leaves other port requests to the origin check', async () => {
    const { ports, mayServePort, dispose } = ingressHost();
    const worker = workerEnd(ports[0]!);
    expect((await worker.ask('/__port/8000/api', { ingress: true })).status).toBe(403); // nothing registered
    expect(mayServePort).not.toHaveBeenCalled();
    expect((await worker.ask('/__port/3000/', {})).status).toBe(200); // a page's request to a workspace port: by origin, as before
    expect((await worker.ask('/__port/8000/')).status).toBe(403); // the host's own (a navigation): by origin, as before
    expect(mayServePort.mock.calls.map(([port]) => port)).toEqual([3000, 8000]);
    dispose();
  });
});
