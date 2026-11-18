import { describe, expect, it, vi } from 'vitest';
import { PreviewShieldError, previewOriginKey, previewOriginTemplate } from '../src/previewOrigin.js';
import { createShieldTelemetry, type SecurityEvent } from '../src/security.js';
import { createPreviewOrigins } from '../src/previewOrigins.js';
import type { PreviewTransport } from '../src/transport.js';

/** A transport that records the Workers it was asked for. */
function fakeTransport(origin: string) {
  const spawned: Array<{ kind?: string; policy?: string }> = [];
  const transport: PreviewTransport = {
    origin,
    scope: '/__bfwc/',
    attach: vi.fn(),
    onReattach: () => () => undefined,
    send: vi.fn(),
    createWorker: (kind, policy) => {
      spawned.push({ kind, policy });
      return { onmessage: null, postMessage() {}, terminate() {} };
    },
    dispose: vi.fn(),
  };
  return { transport, spawned };
}

const PAGE = 'https://app.example.com';
const RELAY_URL = 'https://preview.example.com/__bfwc/relay.html';
const TEMPLATE = previewOriginTemplate('https://{key}.preview.example.com');
const appOrigin = (applicationId: string, runtimeId = 'project-1') => `https://${previewOriginKey(runtimeId, applicationId)}.preview.example.com`;

function origins(options: { previewOrigin?: typeof TEMPLATE; workerPolicy?: string | ((applicationId: string) => string | undefined); runtimeId?: string } = {}) {
  const shared = fakeTransport('https://preview.example.com');
  const opened: Array<{ url: string; fake: ReturnType<typeof fakeTransport>; detach: ReturnType<typeof vi.fn> }> = [];
  const events: SecurityEvent[] = [];
  const set = createPreviewOrigins({
    shared: shared.transport,
    relayUrl: RELAY_URL,
    embeddingOrigin: PAGE,
    runtimeId: options.runtimeId ?? 'project-1',
    previewOrigin: options.previewOrigin,
    workerPolicy: options.workerPolicy,
    open: (url) => {
      const fake = fakeTransport(new URL(url).origin);
      opened.push({ url, fake, detach: vi.fn() });
      return fake.transport;
    },
    onOpened: () => opened.at(-1)!.detach,
    telemetry: createShieldTelemetry({ sink: { emit: (event) => void events.push(event) } }),
  });
  return { set, shared, opened, events };
}

describe('per-application preview origins', () => {
  it('keeps every application on the shared origin without previewOrigin', () => {
    const { set, shared, opened } = origins();
    expect(set.enabled).toBe(false);
    expect(set.originOf('shop')).toBe('https://preview.example.com');
    set.createWorker!('node', 'shop');
    expect(shared.spawned).toHaveLength(1);
    expect(opened).toHaveLength(0);
    expect(set.mayServe('https://preview.example.com', { applicationId: 'shop', serviceId: 'api' })).toBe(true);
  });

  it("opens each application's relay at the shared relay's path on its own origin, once", () => {
    const { set, shared, opened } = origins({ previewOrigin: TEMPLATE });
    expect(set.originOf('shop')).toBe(appOrigin('shop'));
    set.createWorker!('node', 'shop');
    set.createWorker!('python', 'shop');
    set.createWorker!('node', 'blog');
    expect(opened.map((relay) => relay.url)).toEqual([`${appOrigin('shop')}/__bfwc/relay.html`, `${appOrigin('blog')}/__bfwc/relay.html`]);
    expect(opened[0]!.fake.spawned.map((worker) => worker.kind)).toEqual(['node', 'python']);
    // The workspace and the platform stay on the shared relay.
    set.createWorker!('node', undefined);
    set.createWorker!('node', 'workspace');
    expect(shared.spawned).toHaveLength(2);
    expect(set.transports().map((transport) => transport.origin)).toEqual(['https://preview.example.com', appOrigin('shop'), appOrigin('blog')]);
  });

  it('gives the same application different origins in different projects', () => {
    expect(origins({ previewOrigin: TEMPLATE, runtimeId: 'project-1' }).set.originOf('shop')).not.toBe(origins({ previewOrigin: TEMPLATE, runtimeId: 'project-2' }).set.originOf('shop'));
  });

  it("serves an application's ports only through its own origin, and the workspace's only through the shared one", () => {
    const { set } = origins({ previewOrigin: TEMPLATE });
    set.originOf('shop');
    set.originOf('blog');
    const shop = { applicationId: 'shop', serviceId: 'api' };
    expect(set.mayServe(appOrigin('shop'), shop)).toBe(true);
    expect(set.mayServe(appOrigin('blog'), shop)).toBe(false);
    expect(set.mayServe('https://preview.example.com', shop)).toBe(false);
    expect(set.mayServe('https://preview.example.com', { applicationId: 'workspace', serviceId: 'workspace' })).toBe(true);
    expect(set.mayServe(appOrigin('shop'), { applicationId: 'workspace', serviceId: 'workspace' })).toBe(false);
    // An application whose origin was never computed has none to be served through.
    expect(set.mayServe(appOrigin('other'), { applicationId: 'other', serviceId: 'web' })).toBe(false);
    expect(set.accepts(appOrigin('shop'))).toBe(true);
    expect(set.accepts('https://evil.example')).toBe(false);
  });

  it('refuses an invalid or colliding computed origin, reporting it, and starts no Worker', () => {
    const { set, events, opened } = origins({ previewOrigin: () => 'https://same.preview.example.com' });
    expect(set.originOf('shop')).toBe('https://same.preview.example.com');
    expect(() => set.createWorker!('node', 'blog')).toThrow(PreviewShieldError);
    expect(events.map((event) => [event.reasonCode, event.context.applicationId])).toEqual([['ingress.preview_origin_invalid', 'blog']]);
    expect(opened).toHaveLength(0);

    const throwing = origins({
      previewOrigin: () => {
        throw new Error('no DNS');
      },
    });
    expect(() => throwing.set.originOf('shop')).toThrow(/no DNS/);
    expect(throwing.events[0]?.reasonCode).toBe('ingress.preview_origin_invalid');

    for (const bad of [PAGE, 'https://preview.example.com', 'http://x.preview.example.com']) {
      expect(() => origins({ previewOrigin: () => bad }).set.originOf('shop')).toThrow(PreviewShieldError);
    }
  });

  it("closes an application's relay when it ends, keeping its origin its own", () => {
    const { set, opened } = origins({ previewOrigin: TEMPLATE });
    set.createWorker!('node', 'shop');
    set.release('shop');
    expect(opened[0]!.detach).toHaveBeenCalledTimes(1);
    expect(opened[0]!.fake.transport.dispose).toHaveBeenCalledTimes(1);
    expect(set.transports()).toHaveLength(1);
    expect(set.originOf('shop')).toBe(appOrigin('shop'));
    set.createWorker!('node', 'shop');
    expect(opened).toHaveLength(2);
  });

  it("starts an application's Workers under its egress policy id, and the workspace's under none", () => {
    const { set, shared, opened } = origins({ previewOrigin: TEMPLATE, workerPolicy: (applicationId) => `signed.${applicationId}` });
    set.createWorker!('node', 'shop');
    set.createWorker!('node', undefined);
    expect(opened[0]!.fake.spawned).toEqual([{ kind: 'node', policy: 'signed.shop' }]);
    expect(shared.spawned).toEqual([{ kind: 'node', policy: undefined }]);

    const fixed = origins({ workerPolicy: 'signed.runtime' });
    fixed.set.createWorker!('node', 'shop');
    fixed.set.createWorker!('node', 'workspace');
    expect(fixed.shared.spawned.map((worker) => worker.policy)).toEqual(['signed.runtime', undefined]);
  });
});
