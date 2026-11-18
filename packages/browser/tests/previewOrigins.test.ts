import { afterEach, describe, expect, it, vi } from 'vitest';
import { PreviewShieldError, previewOriginKey, previewOriginTemplate } from '../src/previewOrigin.js';
import { createShieldTelemetry, type SecurityEvent } from '../src/security.js';
import { createPreviewOrigins, type PreviewOriginsOptions } from '../src/previewOrigins.js';
import { relayConfigOf } from '../src/relayConfig.js';
import type { PreviewTransport } from '../src/transport.js';

/** A transport that records the Workers it was asked for. */
function fakeTransport(origin: string) {
  const spawned: Array<{ kind?: string; policy?: string; onUndeliverable?: (message: string) => void }> = [];
  const transport: PreviewTransport = {
    origin,
    scope: '/__bfwc/',
    attach: vi.fn(),
    onReattach: () => () => undefined,
    send: vi.fn(),
    createWorker: (kind, policy, onUndeliverable) => {
      spawned.push({ kind, policy, ...(onUndeliverable ? { onUndeliverable } : {}) });
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
const noWorker = () => ({ onmessage: null, postMessage() {}, terminate() {} });

type Extra = Pick<PreviewOriginsOptions, 'sharedPreviewOrigin' | 'previewEgress' | 'cspReportUrl' | 'createWorker'>;

function origins(options: { previewOrigin?: typeof TEMPLATE; workerPolicy?: string | ((applicationId: string) => string | undefined); runtimeId?: string } & Extra = {}) {
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
    sharedPreviewOrigin: options.sharedPreviewOrigin,
    previewEgress: options.previewEgress,
    cspReportUrl: options.cspReportUrl,
    createWorker: options.createWorker,
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

const reasons = (events: SecurityEvent[]) => events.map((event) => [event.reasonCode, event.context.applicationId]);

describe('per-application preview origins', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses an application without previewOrigin, before any Worker starts, unless opted out by name', () => {
    const { set, shared, events } = origins();
    for (const run of [() => set.originOf('shop'), () => set.createWorker!('node', 'shop')]) {
      let error: unknown;
      try {
        run();
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(PreviewShieldError);
      expect((error as PreviewShieldError).reason).toBe('ingress.app_origin_required');
    }
    expect(shared.spawned).toHaveLength(0);
    expect(reasons(events)).toEqual([
      ['ingress.app_origin_required', 'shop'],
      ['ingress.app_origin_required', 'shop'],
    ]);
    // The workspace and the platform never need one.
    expect(set.originOf(undefined)).toBe('https://preview.example.com');
    expect(set.originOf('workspace')).toBe('https://preview.example.com');
    expect(set.originOf('platform')).toBe('https://preview.example.com');
    set.createWorker!('node', undefined);
    expect(shared.spawned).toHaveLength(1);
  });

  it('under the named opt-out, warns and reports once per application start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { set, events } = origins({ sharedPreviewOrigin: 'unprotected' });
    set.originOf('shop');
    set.createWorker!('node', 'shop');
    set.originOf('blog');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(reasons(events)).toEqual([
      ['ingress.shared_preview_origin', 'shop'],
      ['ingress.shared_preview_origin', 'blog'],
    ]);
    set.release('shop'); // the application ended: its next start is announced again
    set.originOf('shop');
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('keeps every application on the shared origin under the opt-out', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { set, shared, opened } = origins({ sharedPreviewOrigin: 'unprotected' });
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

  it('gives an application the same origin in a fresh runtime of the same project (a page reload)', () => {
    const id = 'app:p1:0123456789abcdef';
    expect(origins({ previewOrigin: TEMPLATE }).set.originOf(id)).toBe(origins({ previewOrigin: TEMPLATE }).set.originOf(id));
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
    expect(reasons(events)).toEqual([['ingress.preview_origin_invalid', 'blog']]);
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

  it("closes an application's relay when it ends and stops accepting its origin, which it gets back on its next start", () => {
    const { set, opened } = origins({ previewOrigin: TEMPLATE });
    set.createWorker!('node', 'shop');
    expect(set.accepts(appOrigin('shop'))).toBe(true);
    set.release('shop');
    expect(opened[0]!.detach).toHaveBeenCalledTimes(1);
    expect(opened[0]!.fake.transport.dispose).toHaveBeenCalledTimes(1);
    expect(set.transports()).toHaveLength(1);
    expect(set.accepts(appOrigin('shop'))).toBe(false); // an ended application's previews are no longer heard
    expect(set.mayServe(appOrigin('shop'), { applicationId: 'shop', serviceId: 'api' })).toBe(false);
    set.createWorker!('node', 'shop');
    expect(opened).toHaveLength(2);
    expect(opened[1]!.url).toBe(opened[0]!.url); // the stable key: the same origin, so the same storage
  });

  it("frames each application's relay with its host-side egress, policy id and report endpoint", () => {
    const { set, opened } = origins({
      previewOrigin: TEMPLATE,
      previewEgress: (applicationId) => (applicationId === 'shop' ? ['https://api.shop.example'] : []),
      workerPolicy: (applicationId) => `signed.${applicationId}`,
      cspReportUrl: 'https://api.example.com/csp',
    });
    set.createWorker!('node', 'shop');
    expect(relayConfigOf(opened[0]!.url)).toEqual({ egress: ['https://api.shop.example'], policy: 'signed.shop', report: 'https://api.example.com/csp' });
    expect(new URL(opened[0]!.url).pathname).toBe('/__bfwc/relay.html');
  });

  it("starts an application's Workers under its egress policy id, and the workspace's under none", () => {
    const { set, shared, opened } = origins({ previewOrigin: TEMPLATE, workerPolicy: (applicationId) => `signed.${applicationId}` });
    set.createWorker!('node', 'shop');
    set.createWorker!('node', undefined);
    expect(opened[0]!.fake.spawned.map(({ kind, policy }) => ({ kind, policy }))).toEqual([{ kind: 'node', policy: 'signed.shop' }]);
    expect(shared.spawned.map(({ kind, policy }) => ({ kind, policy }))).toEqual([{ kind: 'node', policy: undefined }]);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fixed = origins({ workerPolicy: 'signed.runtime', sharedPreviewOrigin: 'unprotected' });
    fixed.set.createWorker!('node', 'shop');
    fixed.set.createWorker!('node', 'workspace');
    expect(fixed.shared.spawned.map((worker) => worker.policy)).toEqual(['signed.runtime', undefined]);
  });

  it('drops and reports a malformed policy id (once per start): its Workers get the most restrictive policy', () => {
    const { set, opened, events } = origins({ previewOrigin: TEMPLATE, workerPolicy: () => 'not a valid id' });
    set.createWorker!('node', 'shop');
    set.createWorker!('node', 'shop');
    expect(opened[0]!.fake.spawned.map((worker) => worker.policy)).toEqual([undefined, undefined]);
    expect(reasons(events)).toEqual([['egress.policy_invalid', 'shop']]);
  });

  it("hands a custom Worker factory each application's origin and policy instead of skipping them", () => {
    const targets: unknown[] = [];
    const { set } = origins({
      previewOrigin: TEMPLATE,
      workerPolicy: 'signed.runtime',
      createWorker: (kind, applicationId, target) => {
        targets.push({ kind, applicationId, target });
        return noWorker();
      },
    });
    set.createWorker!('node', 'shop');
    set.createWorker!('python', undefined);
    expect(targets).toEqual([
      { kind: 'node', applicationId: 'shop', target: { origin: appOrigin('shop'), policy: 'signed.runtime' } },
      { kind: 'python', applicationId: undefined, target: { origin: 'https://preview.example.com', policy: undefined } },
    ]);
    // A custom factory never gets an application without an origin of its own.
    expect(() => origins({ createWorker: noWorker }).set.createWorker!('node', 'shop')).toThrow(PreviewShieldError);
  });

  it("reports a message that could not cross to an application's Worker (messageerror) against that application", () => {
    const { set, opened, events } = origins({ previewOrigin: TEMPLATE });
    set.createWorker!('node', 'shop');
    opened[0]!.fake.spawned[0]!.onUndeliverable!('could not deliver');
    expect(reasons(events)).toEqual([['process.message_undeliverable', 'shop']]);
  });
});
