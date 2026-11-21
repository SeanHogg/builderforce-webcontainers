import { describe, expect, it } from 'vitest';
import {
  CSP_VIOLATION_LIMIT,
  CSP_VIOLATION_MESSAGE_TYPE,
  PREVIEW_TIMING_FEATURES,
  TIMING_BATCH_SIZE,
  TIMING_MESSAGE_TYPE,
  cspBlockedOrigin,
  previewDiagnosticsScript,
} from '../src/previewDiagnostics.js';
import { ESM_SH_ORIGIN, createEsmShCdnFactory, esmShCdnFactory } from '../src/packageCdn.js';
import { transformHtml } from '../src/html.js';

interface Posted {
  type: string;
  [key: string]: unknown;
}

type ObserverCallback = (list: { getEntries(): unknown[] }) => void;

/**
 * Runs the script against a stubbed window: a parent that records, observers and timers the test drives.
 * `observer`: `null` for an engine without PerformanceObserver; else its `supportedEntryTypes`, or an entry type `observe` throws for.
 */
function runScript(nonce = 'n0nce', observer: null | { supportedEntryTypes?: string[]; throwOn?: string } = {}) {
  const posted: Posted[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const observers: Record<string, ObserverCallback> = {};
  const timers: Array<() => void> = [];
  class FakeObserver {
    static supportedEntryTypes = observer?.supportedEntryTypes;
    constructor(private readonly callback: ObserverCallback) {}
    observe(options: { type: string }) {
      if (options.type === observer?.throwOn) throw new TypeError(`${options.type} is not supported`);
      observers[options.type] = this.callback;
    }
  }
  const body = previewDiagnosticsScript(nonce).replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function('window', 'parent', 'location', 'addEventListener', 'PerformanceObserver', 'performance', 'setTimeout', 'clearTimeout', body)(
    {},
    { postMessage: (message: Posted) => posted.push(message) },
    { href: 'https://preview.test/__bfwc/p1/' },
    (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
    observer === null ? undefined : FakeObserver,
    { timeOrigin: 1_000_000 },
    (callback: () => void) => timers.push(callback),
    () => undefined,
  );
  return {
    posted,
    violate: (event: Record<string, unknown>) => listeners.securitypolicyviolation!(event),
    entries: (type: string, entries: unknown[]) => observers[type]!({ getEntries: () => entries }),
    flushTimers: () => timers.splice(0).forEach((timer) => timer()),
    pagehide: () => listeners.pagehide!({}),
  };
}

const ofType = (posted: Posted[], type: string) => posted.filter((m) => m.type === type);

describe('cspBlockedOrigin', () => {
  it('reduces a URL to its origin and keeps keywords, never a path or query', () => {
    expect(cspBlockedOrigin('https://tile.openstreetmap.org/12/1/2.png?key=secret')).toBe('https://tile.openstreetmap.org');
    expect(cspBlockedOrigin('wss://socket.example.com:8443/live')).toBe('wss://socket.example.com:8443');
    expect(cspBlockedOrigin('inline')).toBe('inline');
    expect(cspBlockedOrigin('eval')).toBe('eval');
    expect(cspBlockedOrigin('data')).toBe('data');
    expect(cspBlockedOrigin('data:image/png;base64,AAAA')).toBe('data');
    expect(cspBlockedOrigin('blob:https://preview.test/0d9f')).toBe('blob');
    expect(cspBlockedOrigin('')).toBeUndefined();
    expect(cspBlockedOrigin('not a url')).toBeUndefined();
    expect(cspBlockedOrigin(42)).toBeUndefined();
  });
});

describe('previewDiagnosticsScript', () => {
  it('forwards a violation as directive + blocked origin + disposition, with the nonce', () => {
    const { posted, violate } = runScript();
    violate({ effectiveDirective: 'img-src', blockedURI: 'https://tile.openstreetmap.org/1/2/3.png?k=1', disposition: 'enforce' });
    violate({ effectiveDirective: 'script-src-elem', blockedURI: 'inline', disposition: 'report' });
    expect(ofType(posted, CSP_VIOLATION_MESSAGE_TYPE)).toEqual([
      { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'img-src', blockedOrigin: 'https://tile.openstreetmap.org', disposition: 'enforce', href: 'https://preview.test/__bfwc/p1/', nonce: 'n0nce' },
      { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'script-src-elem', blockedOrigin: 'inline', disposition: 'report', href: 'https://preview.test/__bfwc/p1/', nonce: 'n0nce' },
    ]);
    expect(JSON.stringify(posted)).not.toContain('png');
  });

  it('posts each (directive, origin) once per page load, and at most the limit', () => {
    const { posted, violate } = runScript();
    for (let i = 0; i < 5; i++) violate({ effectiveDirective: 'img-src', blockedURI: `https://tiles.example/${i}.png`, disposition: 'enforce' });
    violate({ effectiveDirective: 'connect-src', blockedURI: 'https://tiles.example/api', disposition: 'enforce' });
    expect(ofType(posted, CSP_VIOLATION_MESSAGE_TYPE)).toHaveLength(2);
    for (let i = 0; i < CSP_VIOLATION_LIMIT * 2; i++) violate({ effectiveDirective: 'img-src', blockedURI: `https://h${i}.example/x`, disposition: 'enforce' });
    expect(ofType(posted, CSP_VIOLATION_MESSAGE_TYPE)).toHaveLength(CSP_VIOLATION_LIMIT);
  });

  it('drops a violation it cannot reduce (malformed directive or blocked URI)', () => {
    const { posted, violate } = runScript();
    violate({ effectiveDirective: 'img-src; script-src *', blockedURI: 'https://a.example/', disposition: 'enforce' });
    violate({ effectiveDirective: 'img-src', blockedURI: '', disposition: 'enforce' });
    expect(ofType(posted, CSP_VIOLATION_MESSAGE_TYPE)).toEqual([]);
  });

  it('batches resource timings by origin (no URL) and reports first contentful paint', () => {
    const { posted, entries, flushTimers } = runScript();
    entries('resource', [
      { name: 'https://esm.sh/react@18?dev', initiatorType: 'script', duration: 120.4, responseStatus: 200, transferSize: 0, decodedBodySize: 5000 },
      { name: 'https://api.example.com/items?token=x', initiatorType: 'fetch', duration: 40, responseStatus: 500, transferSize: 300, decodedBodySize: 200 },
      { name: 'data:image/png;base64,AAAA', initiatorType: 'img', duration: 1 },
    ]);
    entries('paint', [{ name: 'first-paint', startTime: 50 }, { name: 'first-contentful-paint', startTime: 80 }]);
    expect(ofType(posted, TIMING_MESSAGE_TYPE)).toEqual([]); // batched
    flushTimers();
    const [batch] = ofType(posted, TIMING_MESSAGE_TYPE);
    expect(batch!.entries).toEqual([
      { kind: 'resource', origin: 'https://esm.sh', initiator: 'script', durationMs: 120, status: 200, cached: true },
      { kind: 'resource', origin: 'https://api.example.com', initiator: 'fetch', durationMs: 40, status: 500, cached: false },
      { kind: 'paint', startMs: 80, at: 1_000_080 },
    ]);
    expect(batch!.nonce).toBe('n0nce');
    expect(JSON.stringify(posted)).not.toContain('token');
  });

  it('splits a large burst into batches and flushes on pagehide', () => {
    const { posted, entries, pagehide } = runScript();
    entries('resource', Array.from({ length: TIMING_BATCH_SIZE + 5 }, (_, i) => ({ name: `https://cdn.example/${i}.js`, initiatorType: 'script', duration: i })));
    pagehide();
    const batches = ofType(posted, TIMING_MESSAGE_TYPE);
    expect(batches.map((b) => (b.entries as unknown[]).length)).toEqual([TIMING_BATCH_SIZE, 5]);
    expect((batches[0]!.entries as Array<{ cached: unknown }>)[0]!.cached).toBeNull(); // no body size: the cache state is unknown
  });

  it('reports a measurement it cannot take instead of leaving it out silently', () => {
    // No PerformanceObserver at all: both measurements are reported unavailable.
    const none = runScript('n0nce', null);
    none.flushTimers();
    expect(ofType(none.posted, TIMING_MESSAGE_TYPE).flatMap((m) => m.entries as unknown[])).toEqual([
      { kind: 'unavailable', feature: PREVIEW_TIMING_FEATURES.resource },
      { kind: 'unavailable', feature: PREVIEW_TIMING_FEATURES.paint },
    ]);
    // An engine without paint timing (supportedEntryTypes says so): resource timings still flow, paint is reported unavailable.
    const noPaint = runScript('n0nce', { supportedEntryTypes: ['resource'] });
    noPaint.entries('resource', [{ name: 'https://esm.sh/react', initiatorType: 'script', duration: 3 }]);
    noPaint.flushTimers();
    const entries = ofType(noPaint.posted, TIMING_MESSAGE_TYPE).flatMap((m) => m.entries as Array<{ kind: string; feature?: string }>);
    expect(entries.map((e) => e.kind)).toEqual(['unavailable', 'resource']);
    expect(entries[0]!.feature).toBe(PREVIEW_TIMING_FEATURES.paint);
    // observe() throwing for an entry type is reported the same way.
    const throwing = runScript('n0nce', { throwOn: 'resource' });
    throwing.flushTimers();
    expect(ofType(throwing.posted, TIMING_MESSAGE_TYPE).flatMap((m) => m.entries as unknown[])).toEqual([{ kind: 'unavailable', feature: PREVIEW_TIMING_FEATURES.resource }]);
  });

  it('keeps the parent and timers it started with when the app replaces those globals later', () => {
    const posted: Posted[] = [];
    const replaced: Posted[] = [];
    const timers: Array<() => void> = [];
    const listeners: Record<string, (event: unknown) => void> = {};
    let onResource: ObserverCallback | undefined;
    class FakeObserver {
      constructor(private readonly callback: ObserverCallback) {}
      observe(options: { type: string }) {
        if (options.type === 'resource') onResource = this.callback;
      }
    }
    const scope: Record<string, unknown> = {
      window: {},
      parent: { postMessage: (message: Posted) => posted.push(message) },
      location: { href: 'https://preview.test/__bfwc/p1/' },
      addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
      PerformanceObserver: FakeObserver,
      performance: { timeOrigin: 0 },
      setTimeout: (callback: () => void) => timers.push(callback),
      clearTimeout: () => undefined,
    };
    const body = previewDiagnosticsScript('n0nce').replace(/^<script>/, '').replace(/<\/script>$/, '');
    // Sloppy-mode `with`: the script's bare globals resolve on `scope`, as they would on `window`.
    new Function('scope', `with (scope) { ${body} }`)(scope);
    // The app's code runs after the script: it replaces the globals the script reports through.
    scope.parent = { postMessage: (message: Posted) => replaced.push(message) };
    scope.setTimeout = () => {
      throw new Error('the app replaced setTimeout');
    };
    listeners.securitypolicyviolation!({ effectiveDirective: 'img-src', blockedURI: 'https://a.example/x.png', disposition: 'enforce' });
    onResource!({ getEntries: () => [{ name: 'https://esm.sh/react', initiatorType: 'script', duration: 3 }] }); // schedules on the original timer
    timers.splice(0).forEach((timer) => timer());
    expect(replaced).toEqual([]);
    expect(ofType(posted, CSP_VIOLATION_MESSAGE_TYPE)).toHaveLength(1);
    expect(ofType(posted, TIMING_MESSAGE_TYPE)).toHaveLength(1);
  });

  it('runs in every dev-server page, after the error bridge', () => {
    const html = transformHtml('<html><head></head><body></body></html>', { base: '/__bfwc/p1/', nonce: 'n0nce' });
    expect(html).toContain(JSON.stringify(CSP_VIOLATION_MESSAGE_TYPE));
    expect(html.indexOf('bfwc:error')).toBeLessThan(html.indexOf(CSP_VIOLATION_MESSAGE_TYPE));
  });
});

describe('the package CDN factory names its origins', () => {
  it('esm.sh by default, and a configured esm.sh-compatible server by its origin', () => {
    expect(esmShCdnFactory.origins).toEqual([ESM_SH_ORIGIN]);
    expect(createEsmShCdnFactory({ origin: 'https://mirror.example.com:8443/esm/' }).origins).toEqual(['https://mirror.example.com:8443']);
  });

  it('a configured factory builds its URLs on that server', async () => {
    const cdn = await createEsmShCdnFactory({ origin: 'https://mirror.example.com/esm' })({}, { dev: false });
    expect(cdn.urlFor('react', '')).toBe('https://mirror.example.com/esm/react');
  });
});
