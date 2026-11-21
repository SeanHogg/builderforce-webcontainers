/**
 * `runtime.diagnostics()`: one plain-data snapshot of how this runtime loaded,
 * so a slowdown report comes with numbers. Only what was measured is reported:
 *
 * - phases the host times itself (runtime start, service worker ready, compiler
 *   load = esbuild-wasm download and init) and the first preview paint, which the
 *   preview page reports (`first-contentful-paint`);
 * - requests by ORIGIN (never a URL): the preview pages' own (their resource
 *   timings, reported by the diagnostics script) and this page's requests to the
 *   package CDN and for the compiler (its own resource timings);
 * - the CSP violations previews reported (diagnostics only: they come from the app's page);
 * - whether the package/compiler downloads came from a cache, when the browser says;
 * - which measurements could not run (`unavailable`), so a missing number is never
 *   mistaken for a zero.
 *
 * Every list is bounded (ring buffers, capped maps), so a long session or a
 * flooding preview cannot grow it.
 */
import type { PreviewCspViolation, PreviewTiming } from './previewMessages.js';

export interface DiagnosticsPhase {
  /** `runtime.start`, `serviceWorker.ready`, `compiler.load`, `preview.firstPaint`. */
  name: string;
  /** Milliseconds after the runtime started (negative: before it). */
  startMs: number;
  durationMs: number;
}

export interface OriginRequests {
  origin: string;
  count: number;
  /** Answered with a status of 400 or more. */
  failed: number;
  totalMs: number;
}

export interface SlowRequest {
  origin: string;
  /** What asked for it (`script`, `img`, `fetch`, `compiler` …): never a path. */
  label: string;
  durationMs: number;
  /** When the browser exposed it. */
  status?: number;
}

/**
 * `warm`: every package-CDN and compiler response whose cache state the browser
 * exposed came from a cache; `cold`: at least one was downloaded; `unknown`: none
 * exposed it (nothing loaded yet, or the server sent no `Timing-Allow-Origin`).
 */
export type CacheState = 'cold' | 'warm' | 'unknown';

export interface RuntimeDiagnostics {
  phases: DiagnosticsPhase[];
  /** Requests to the package CDN's origins (the factory's `origins`; a `https://*.x` one counts its subdomains), from this page and from previews. */
  cdn: { requests: number; totalMs: number; errors: number };
  /** Per origin, busiest first. Past {@link DIAGNOSTICS_LIMITS}`.origins` origins, the rest are counted under `*`. */
  requests: OriginRequests[];
  /** The slowest requests, slowest first. */
  slowest: SlowRequest[];
  /** The most recent CSP violations previews reported, oldest first. */
  cspViolations: PreviewCspViolation[];
  cache: CacheState;
  /**
   * Measurements that could not run, so their absence above is not a zero:
   * `resourceTiming` (this page's own requests), `preview.resourceTiming` and
   * `preview.paintTiming` (a preview page reported it could not observe them).
   * Sorted; empty when everything was measurable.
   */
  unavailable: string[];
}

/** This page's own resource timing (see `observeHostRequests`). */
export const HOST_RESOURCE_TIMING = 'resourceTiming';

/** One request, measured. */
export interface RequestTiming {
  origin: string;
  label: string;
  durationMs: number;
  status?: number;
  /** Whether a cache answered; undefined when the browser did not say. */
  cached?: boolean;
}

export const DIAGNOSTICS_LIMITS = { phases: 32, origins: 64, slowest: 10, cspViolations: 50 } as const;

/** The label of the compiler download (esbuild.wasm): it counts toward the cache state. */
export const COMPILER_LABEL = 'compiler';

export interface DiagnosticsOptions {
  /** The package CDN's origins (`PackageCdnFactory.origins`). */
  cdnOrigins: readonly string[];
  /** Epoch milliseconds. Default `performance.timeOrigin + performance.now()`. */
  now?: () => number;
}

export interface DiagnosticsCollector {
  /** When the runtime started (epoch ms): phases are relative to it. */
  readonly startedAt: number;
  /** Start timing phase `name`; call the result when it ends. */
  begin(name: string): () => void;
  /** Time `work` as phase `name` (recorded whether it resolves or rejects). */
  time<T>(name: string, work: Promise<T>): Promise<T>;
  request(timing: RequestTiming): void;
  cspViolation(violation: PreviewCspViolation): void;
  /** A preview page's report: a resource timing, its first paint (the runtime's first only), or a measurement it could not take. */
  previewTiming(timing: PreviewTiming): void;
  /** Record that measurement `feature` could not run (listed once in `unavailable`). */
  unavailable(feature: string): void;
  snapshot(): RuntimeDiagnostics;
}

/** A set of origins a request's origin is looked up in (a `Set`, or {@link cdnOriginSet}). */
export interface OriginSet {
  has(origin: string): boolean;
}

/**
 * The CDN origins as an {@link OriginSet}: exact origins, and wildcard ones
 * (`https://*.cdn.example`, as egress allows) matching any subdomain on the same
 * scheme and port — as the CSP source matches them (not the bare `cdn.example`).
 */
export function cdnOriginSet(origins: readonly string[]): OriginSet {
  const exact = new Set<string>();
  const wildcards: Array<{ scheme: string; suffix: string; port: string }> = [];
  for (const origin of origins) {
    const wildcard = /^([a-z][a-z0-9+.-]*:\/\/)\*(\.[^:/]+)(:\d+)?$/i.exec(origin);
    if (wildcard) wildcards.push({ scheme: wildcard[1]!.toLowerCase(), suffix: wildcard[2]!.toLowerCase(), port: wildcard[3] ?? '' });
    else exact.add(origin.toLowerCase());
  }
  return {
    has(origin) {
      const lower = origin.toLowerCase();
      if (exact.has(lower)) return true;
      return wildcards.some(({ scheme, suffix, port }) => {
        if (!lower.startsWith(scheme)) return false;
        const hostPort = lower.slice(scheme.length);
        const colon = hostPort.lastIndexOf(':');
        const host = colon < 0 ? hostPort : hostPort.slice(0, colon);
        const ownPort = colon < 0 ? '' : hostPort.slice(colon);
        return ownPort === port && host.endsWith(suffix) && host.length > suffix.length;
      });
    },
  };
}

const defaultNow = () => (typeof performance !== 'undefined' ? performance.timeOrigin + performance.now() : Date.now());
const round = (ms: number) => Math.round(ms * 10) / 10;

export function createDiagnostics(options: DiagnosticsOptions): DiagnosticsCollector {
  const now = options.now ?? defaultNow;
  const startedAt = now();
  const cdnOrigins = cdnOriginSet(options.cdnOrigins);
  const phases: DiagnosticsPhase[] = [];
  const origins = new Map<string, OriginRequests>();
  const slowest: SlowRequest[] = [];
  const violations: PreviewCspViolation[] = [];
  const cdn = { requests: 0, totalMs: 0, errors: 0 };
  const cache = { cached: 0, downloaded: 0 };
  /** Bounded by its callers: the host's one feature name and the preview's checked ones. */
  const unavailable = new Set<string>();
  let painted = false;

  const addPhase = (name: string, at: number, durationMs: number) => {
    if (phases.length < DIAGNOSTICS_LIMITS.phases) phases.push({ name, startMs: round(at - startedAt), durationMs: round(Math.max(0, durationMs)) });
  };

  const begin = (name: string) => {
    const at = now();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      addPhase(name, at, now() - at);
    };
  };

  const request = (timing: RequestTiming) => {
    const failed = timing.status !== undefined && timing.status >= 400;
    const key = origins.has(timing.origin) || origins.size < DIAGNOSTICS_LIMITS.origins ? timing.origin : '*';
    const entry = origins.get(key) ?? { origin: key, count: 0, failed: 0, totalMs: 0 };
    entry.count++;
    entry.totalMs = round(entry.totalMs + timing.durationMs);
    if (failed) entry.failed++;
    origins.set(key, entry);

    const isCdn = cdnOrigins.has(timing.origin);
    if (isCdn) {
      cdn.requests++;
      cdn.totalMs = round(cdn.totalMs + timing.durationMs);
      if (failed) cdn.errors++;
    }
    if ((isCdn || timing.label === COMPILER_LABEL) && timing.cached !== undefined) cache[timing.cached ? 'cached' : 'downloaded']++;

    if (slowest.length < DIAGNOSTICS_LIMITS.slowest || timing.durationMs > slowest[slowest.length - 1]!.durationMs) {
      slowest.push({ origin: timing.origin, label: timing.label, durationMs: round(timing.durationMs), ...(timing.status !== undefined ? { status: timing.status } : {}) });
      slowest.sort((a, b) => b.durationMs - a.durationMs);
      slowest.length = Math.min(slowest.length, DIAGNOSTICS_LIMITS.slowest);
    }
  };

  return {
    startedAt,
    begin,
    async time(name, work) {
      const end = begin(name);
      try {
        return await work;
      } finally {
        end();
      }
    },
    request,
    cspViolation(violation) {
      violations.push({ ...violation });
      if (violations.length > DIAGNOSTICS_LIMITS.cspViolations) violations.shift();
    },
    previewTiming(timing) {
      if (timing.kind === 'resource') {
        request({ origin: timing.origin, label: timing.initiator, durationMs: timing.durationMs, status: timing.status, cached: timing.cached });
      } else if (timing.kind === 'unavailable') {
        unavailable.add(`preview.${timing.feature}`);
      } else if (!painted) {
        painted = true;
        addPhase('preview.firstPaint', timing.at - timing.startMs, timing.startMs);
      }
    },
    unavailable(feature) {
      unavailable.add(feature);
    },
    snapshot() {
      return {
        phases: phases.map((phase) => ({ ...phase })),
        cdn: { ...cdn },
        requests: [...origins.values()].map((entry) => ({ ...entry })).sort((a, b) => b.count - a.count),
        slowest: slowest.map((entry) => ({ ...entry })),
        cspViolations: violations.map((violation) => ({ ...violation })),
        cache: cache.downloaded > 0 ? 'cold' : cache.cached > 0 ? 'warm' : 'unknown',
        unavailable: [...unavailable].sort(),
      };
    },
  };
}

/** The slice of `PerformanceResourceTiming` read here. */
interface ResourceEntryLike {
  name: string;
  startTime: number;
  duration: number;
  initiatorType: string;
  transferSize?: number;
  decodedBodySize?: number;
  responseStatus?: number;
  deliveryType?: string;
}

/** A resource timing as a `RequestTiming`, origin only; undefined when it is not one this page measures (`origins`, or the compiler's wasm). */
export function hostRequestTiming(entry: ResourceEntryLike, origins: OriginSet): RequestTiming | undefined {
  let url: URL;
  try {
    url = new URL(entry.name);
  } catch {
    return undefined;
  }
  const compiler = url.pathname.endsWith('/esbuild.wasm');
  if (!compiler && !origins.has(url.origin)) return undefined;
  const size = entry.decodedBodySize ?? 0;
  return {
    origin: url.origin,
    label: compiler ? COMPILER_LABEL : entry.initiatorType || 'other',
    durationMs: entry.duration,
    ...(entry.responseStatus ? { status: entry.responseStatus } : {}),
    ...(size > 0 ? { cached: entry.deliveryType === 'cache' || entry.transferSize === 0 } : {}),
  };
}

interface ObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}
type ObserverConstructor = new (callback: (list: { getEntries(): ResourceEntryLike[] }) => void) => ObserverLike;

/**
 * Feed this page's own requests to the package CDN and for the compiler, made
 * since the runtime started, into `diagnostics`. Returns the stop. Where resource
 * timing cannot be observed (no `PerformanceObserver`, the entry type unsupported,
 * or `observe` throws), nothing is measured and the snapshot lists
 * {@link HOST_RESOURCE_TIMING} under `unavailable`.
 */
export function observeHostRequests(diagnostics: DiagnosticsCollector, cdnOrigins: readonly string[], Observer = (globalThis as unknown as { PerformanceObserver?: ObserverConstructor }).PerformanceObserver): () => void {
  const unavailable = () => {
    diagnostics.unavailable(HOST_RESOURCE_TIMING);
    return () => undefined;
  };
  if (!Observer || typeof performance === 'undefined') return unavailable();
  // An unsupported entry type is ignored by observe() without a throw; supportedEntryTypes says so up front.
  const supported = (Observer as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
  if (supported && !supported.includes('resource')) return unavailable();
  const origins = cdnOriginSet(cdnOrigins);
  const since = diagnostics.startedAt - performance.timeOrigin;
  let observer: ObserverLike | undefined;
  try {
    observer = new Observer((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < since) continue;
        const timing = hostRequestTiming(entry, origins);
        if (timing) diagnostics.request(timing);
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch {
    observer?.disconnect();
    return unavailable(); // an engine that refuses resource timing: reported, not silently skipped
  }
  return () => observer?.disconnect();
}
