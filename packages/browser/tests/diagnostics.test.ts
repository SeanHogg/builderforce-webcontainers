import { describe, expect, it } from 'vitest';
import { COMPILER_LABEL, DIAGNOSTICS_LIMITS, HOST_RESOURCE_TIMING, cdnOriginSet, createDiagnostics, hostRequestTiming, observeHostRequests } from '../src/diagnostics.js';

const CDN = 'https://esm.sh';

function collector(start = 1_000) {
  let clock = start;
  const diagnostics = createDiagnostics({ cdnOrigins: [CDN], now: () => clock });
  return { diagnostics, advance: (ms: number) => (clock += ms) };
}

describe('the diagnostics collector', () => {
  it('times phases relative to the runtime start, rejected work included', async () => {
    const { diagnostics, advance } = collector();
    const started = diagnostics.begin('runtime.start');
    advance(10);
    const ready = diagnostics.time('serviceWorker.ready', Promise.resolve('ok'));
    advance(25);
    await ready;
    await expect(diagnostics.time('compiler.load', Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    advance(5);
    started();
    started(); // ending twice records once
    expect(diagnostics.snapshot().phases).toEqual([
      { name: 'serviceWorker.ready', startMs: 10, durationMs: 25 },
      { name: 'compiler.load', startMs: 35, durationMs: 0 },
      { name: 'runtime.start', startMs: 0, durationMs: 40 },
    ]);
  });

  it('counts CDN requests, per-origin results and the slowest, with no URL anywhere', () => {
    const { diagnostics } = collector();
    diagnostics.request({ origin: CDN, label: 'script', durationMs: 100, status: 200 });
    diagnostics.request({ origin: CDN, label: 'script', durationMs: 50, status: 404 });
    diagnostics.request({ origin: 'https://api.example.com', label: 'fetch', durationMs: 300, status: 500 });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.cdn).toEqual({ requests: 2, totalMs: 150, errors: 1 });
    expect(snapshot.requests).toEqual([
      { origin: CDN, count: 2, failed: 1, totalMs: 150 },
      { origin: 'https://api.example.com', count: 1, failed: 1, totalMs: 300 },
    ]);
    expect(snapshot.slowest[0]).toEqual({ origin: 'https://api.example.com', label: 'fetch', durationMs: 300, status: 500 });
  });

  it('stays bounded: origins past the cap fold into *, slowest keeps the top N, violations are a ring', () => {
    const { diagnostics } = collector();
    for (let i = 0; i < DIAGNOSTICS_LIMITS.origins + 20; i++) diagnostics.request({ origin: `https://h${i}.example`, label: 'img', durationMs: i });
    for (let i = 0; i < DIAGNOSTICS_LIMITS.cspViolations + 7; i++) diagnostics.cspViolation({ directive: 'img-src', blockedOrigin: `https://v${i}.example`, disposition: 'enforce' });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.requests).toHaveLength(DIAGNOSTICS_LIMITS.origins + 1);
    expect(snapshot.requests.find((r) => r.origin === '*')?.count).toBe(20);
    expect(snapshot.slowest).toHaveLength(DIAGNOSTICS_LIMITS.slowest);
    expect(snapshot.slowest[0]!.durationMs).toBe(DIAGNOSTICS_LIMITS.origins + 19);
    expect(snapshot.cspViolations).toHaveLength(DIAGNOSTICS_LIMITS.cspViolations);
    expect(snapshot.cspViolations[0]!.blockedOrigin).toBe('https://v7.example');
  });

  it('reports the cache as unknown, warm or cold from CDN and compiler responses only', () => {
    const { diagnostics } = collector();
    diagnostics.request({ origin: 'https://api.example.com', label: 'fetch', durationMs: 1, cached: false }); // not a package download
    diagnostics.request({ origin: CDN, label: 'script', durationMs: 1 }); // the browser did not say
    expect(diagnostics.snapshot().cache).toBe('unknown');
    diagnostics.request({ origin: CDN, label: 'script', durationMs: 1, cached: true });
    diagnostics.request({ origin: 'https://cdn.jsdelivr.net', label: COMPILER_LABEL, durationMs: 1, cached: true });
    expect(diagnostics.snapshot().cache).toBe('warm');
    diagnostics.request({ origin: 'https://cdn.jsdelivr.net', label: COMPILER_LABEL, durationMs: 900, cached: false });
    expect(diagnostics.snapshot().cache).toBe('cold');
  });

  it("takes previews' resource timings as requests and the first paint as a phase (the first only)", () => {
    const { diagnostics } = collector(10_000);
    diagnostics.previewTiming({ kind: 'resource', origin: CDN, initiator: 'script', durationMs: 20, status: 200, cached: false });
    diagnostics.previewTiming({ kind: 'paint', startMs: 300, at: 10_800 });
    diagnostics.previewTiming({ kind: 'paint', startMs: 100, at: 20_000 });
    const snapshot = diagnostics.snapshot();
    expect(snapshot.cdn.requests).toBe(1);
    expect(snapshot.phases).toEqual([{ name: 'preview.firstPaint', startMs: 500, durationMs: 300 }]);
  });

  it('returns copies: changing a snapshot never changes the collector', () => {
    const { diagnostics } = collector();
    diagnostics.request({ origin: CDN, label: 'script', durationMs: 5 });
    diagnostics.snapshot().requests[0]!.count = 99;
    expect(diagnostics.snapshot().requests[0]!.count).toBe(1);
  });
});

describe('wildcard CDN origins', () => {
  it('regression: count requests to any subdomain of a `https://*.x` CDN origin (same scheme and port), never the bare domain', () => {
    const diagnostics = createDiagnostics({ cdnOrigins: ['https://*.cdn.example.com', 'https://*.ports.example:8443'] });
    for (const origin of ['https://a.cdn.example.com', 'https://A.B.cdn.example.com', 'https://x.ports.example:8443']) diagnostics.request({ origin, label: 'script', durationMs: 10 });
    for (const origin of ['https://cdn.example.com', 'http://a.cdn.example.com', 'https://evilcdn.example.com', 'https://a.cdn.example.com:8443', 'https://x.ports.example']) diagnostics.request({ origin, label: 'script', durationMs: 10 });
    expect(diagnostics.snapshot().cdn).toEqual({ requests: 3, totalMs: 30, errors: 0 });
    expect(cdnOriginSet(['https://*.cdn.example.com']).has('https://a.cdn.example.com')).toBe(true);
    expect(hostRequestTiming({ name: 'https://a.cdn.example.com/react.js', startTime: 5, duration: 3, initiatorType: 'script' }, cdnOriginSet(['https://*.cdn.example.com']))).toMatchObject({ origin: 'https://a.cdn.example.com' });
  });
});

describe("this page's own requests", () => {
  const origins = new Set([CDN]);

  it('keeps CDN requests and the compiler wasm, by origin only; ignores the rest of the page', () => {
    expect(hostRequestTiming({ name: 'https://esm.sh/react@18/package.json', startTime: 5, duration: 30, initiatorType: 'fetch', responseStatus: 200, transferSize: 0, decodedBodySize: 900 }, origins)).toEqual({
      origin: CDN,
      label: 'fetch',
      durationMs: 30,
      status: 200,
      cached: true,
    });
    expect(hostRequestTiming({ name: 'https://cdn.jsdelivr.net/npm/esbuild-wasm@0.25.0/esbuild.wasm', startTime: 5, duration: 700, initiatorType: 'fetch', transferSize: 9_000_000, decodedBodySize: 9_000_000 }, origins)).toEqual({
      origin: 'https://cdn.jsdelivr.net',
      label: COMPILER_LABEL,
      durationMs: 700,
      cached: false,
    });
    expect(hostRequestTiming({ name: 'https://app.example.com/logo.png', startTime: 5, duration: 3, initiatorType: 'img' }, origins)).toBeUndefined();
  });

  it('observes buffered entries made since the runtime started, and stops', () => {
    let callback: ((list: { getEntries(): unknown[] }) => void) | undefined;
    let disconnected = false;
    class FakeObserver {
      constructor(cb: typeof callback) {
        callback = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    }
    const diagnostics = createDiagnostics({ cdnOrigins: [CDN] });
    const since = diagnostics.startedAt - performance.timeOrigin;
    const stop = observeHostRequests(diagnostics, [CDN], FakeObserver as never);
    callback!({
      getEntries: () => [
        { name: 'https://esm.sh/old', startTime: since - 100, duration: 1, initiatorType: 'script' },
        { name: 'https://esm.sh/new', startTime: since + 1, duration: 2, initiatorType: 'script' },
      ],
    });
    expect(diagnostics.snapshot().cdn.requests).toBe(1);
    stop();
    expect(disconnected).toBe(true);
    expect(diagnostics.snapshot().unavailable).toEqual([]);
  });

  it('reports resource timing as unavailable (never silently skipped) when it cannot be observed', () => {
    const missing = createDiagnostics({ cdnOrigins: [CDN] });
    observeHostRequests(missing, [CDN], null as never)(); // no PerformanceObserver (undefined would take the default)
    expect(missing.snapshot().unavailable).toEqual([HOST_RESOURCE_TIMING]);

    class Throwing {
      observe() {
        throw new TypeError('resource timing is not supported');
      }
      disconnect() {}
    }
    const refused = createDiagnostics({ cdnOrigins: [CDN] });
    observeHostRequests(refused, [CDN], Throwing as never)();
    expect(refused.snapshot().unavailable).toEqual([HOST_RESOURCE_TIMING]);

    let observed = false;
    class Unsupported {
      static supportedEntryTypes = ['paint'];
      observe() {
        observed = true;
      }
      disconnect() {}
    }
    const unsupported = createDiagnostics({ cdnOrigins: [CDN] });
    observeHostRequests(unsupported, [CDN], Unsupported as never)();
    expect(unsupported.snapshot().unavailable).toEqual([HOST_RESOURCE_TIMING]);
    expect(observed).toBe(false);
  });

  it("lists a preview's unavailable measurements once each, beside the host's", () => {
    const { diagnostics } = collector();
    diagnostics.previewTiming({ kind: 'unavailable', feature: 'paintTiming' });
    diagnostics.previewTiming({ kind: 'unavailable', feature: 'paintTiming' });
    diagnostics.previewTiming({ kind: 'unavailable', feature: 'resourceTiming' });
    diagnostics.unavailable(HOST_RESOURCE_TIMING);
    expect(diagnostics.snapshot().unavailable).toEqual(['preview.paintTiming', 'preview.resourceTiming', 'resourceTiming']);
  });
});
