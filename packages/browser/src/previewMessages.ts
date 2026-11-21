/**
 * What a preview reports to the host page: errors (uncaught, rejected, or
 * in Angular apps, Error objects / NG-coded strings given to console.error —
 * normalised by previewErrorText) and console output,
 * posted by the bridge script every served page starts with; and CSP violations
 * and request timings, posted by the diagnostics script beside it (core's
 * previewDiagnostics.ts) and checked again here. One window
 * listener per runtime, accepting only messages from the preview origin whose
 * page sits under this runtime's base, so two runtimes on one page never hear
 * each other's previews. A runtime with a nonce (startPreviewRuntime makes one)
 * also requires it on every message: the bridge it injects carries it, so a
 * frame on the preview origin cannot claim another runtime's base by `href`.
 */
import {
  CONSOLE_MESSAGE_TYPE,
  CSP_VIOLATION_LIMIT,
  CSP_VIOLATION_MESSAGE_TYPE,
  ERROR_MESSAGE_TYPE,
  PREVIEW_TIMING_FEATURES,
  TIMING_BATCH_SIZE,
  TIMING_MESSAGE_TYPE,
  cspBlockedOrigin,
  previewErrorText,
  type PreviewErrorSource,
} from '@seanhogg/builderforce-webcontainers-core';

export type { PreviewErrorSource };

export interface PreviewError {
  /** Plain text; for a framework error, the line naming its code (`NG0303: Can't bind to 'foo' …`). */
  message: string;
  stack?: string;
  href: string;
  /** An uncaught throw, an unhandled rejection, or (Angular apps) an Error / NG-coded string passed to `console.error`. */
  source: PreviewErrorSource;
  /** The framework error code (`NG0202`), when the error names one. */
  code?: string;
}

const SOURCES = new Set<string>(['error', 'rejection', 'console']);

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface PreviewConsoleMessage {
  level: ConsoleLevel;
  /** The arguments flattened to text, capped at 4,000 characters. */
  text: string;
  href: string;
}

/**
 * Something the preview's Content-Security-Policy blocked (or, report-only, would
 * have): the directive and the blocked origin — never a path or query. Sent by
 * the preview page, which runs the app's code: a diagnostic, never a security signal.
 */
export interface PreviewCspViolation {
  /** The effective directive (`img-src`, `connect-src`, `script-src-elem` …). */
  directive: string;
  /** The blocked URL's origin (`https://tile.openstreetmap.org`), or its keyword (`inline`, `eval`, `data`, `blob`). */
  blockedOrigin: string;
  /** `enforce`: it was blocked; `report`: a report-only policy (`previewCspMode: 'report-only'`) let it through. */
  disposition: 'enforce' | 'report';
}

/** A measurement a preview page could not take (`PREVIEW_TIMING_FEATURES`). */
export type PreviewTimingFeature = (typeof PREVIEW_TIMING_FEATURES)[keyof typeof PREVIEW_TIMING_FEATURES];

/** One measurement a preview page reported (origins only, never URLs). */
export type PreviewTiming =
  | { kind: 'resource'; origin: string; initiator: string; durationMs: number; status?: number; cached?: boolean }
  /** First contentful paint: `startMs` after the page's navigation started, at `at` (epoch ms). */
  | { kind: 'paint'; startMs: number; at: number }
  /** The page could not measure `feature` (no `PerformanceObserver`, or an entry type its engine lacks). */
  | { kind: 'unavailable'; feature: PreviewTimingFeature };

/**
 * Distinct CSP violations one runtime forwards in total, across all its pages
 * (each page at most `CSP_VIOLATION_LIMIT`): past it, violations are dropped
 * here, whatever a preview posts.
 */
export const CSP_VIOLATION_RUNTIME_LIMIT = 500;

export interface PreviewMessages {
  onError(listener: (error: PreviewError) => void): () => void;
  onConsole(listener: (message: PreviewConsoleMessage) => void): () => void;
  /** CSP violations the preview reported (see `PreviewCspViolation`). */
  onCspViolation(listener: (violation: PreviewCspViolation) => void): () => void;
  /** Request timings and first paint the preview reported, one call per entry. */
  onTiming(listener: (timing: PreviewTiming) => void): () => void;
  dispose(): void;
}

const DIRECTIVE = /^[a-z-]{1,40}$/;
const finite = (value: unknown, max = 1e7): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

/** A posted violation, checked again here (the page is the app's): its origin re-reduced, anything malformed dropped. */
function cspViolationOf(data: { directive?: unknown; blockedOrigin?: unknown; disposition?: unknown }): PreviewCspViolation | undefined {
  const blockedOrigin = cspBlockedOrigin(data.blockedOrigin);
  if (typeof data.directive !== 'string' || !DIRECTIVE.test(data.directive) || !blockedOrigin) return undefined;
  return { directive: data.directive, blockedOrigin, disposition: data.disposition === 'report' ? 'report' : 'enforce' };
}

const FEATURES = new Set<string>(Object.values(PREVIEW_TIMING_FEATURES));

/** A posted timing entry, checked: an http(s) origin only, bounded numbers, a known feature name. */
function previewTimingOf(entry: unknown): PreviewTiming | undefined {
  const e = entry as Record<string, unknown> | null;
  if (!e || typeof e !== 'object') return undefined;
  if (e.kind === 'unavailable') return typeof e.feature === 'string' && FEATURES.has(e.feature) ? { kind: 'unavailable', feature: e.feature as PreviewTimingFeature } : undefined;
  if (e.kind === 'paint') return finite(e.startMs) && finite(e.at, 1e14) ? { kind: 'paint', startMs: e.startMs, at: e.at } : undefined;
  if (e.kind !== 'resource' || !finite(e.durationMs)) return undefined;
  const origin = cspBlockedOrigin(e.origin);
  if (!origin || !/^https?:\/\//.test(origin)) return undefined;
  const initiator = typeof e.initiator === 'string' && /^[a-z0-9-]{1,32}$/i.test(e.initiator) ? e.initiator : 'other';
  return {
    kind: 'resource',
    origin,
    initiator,
    durationMs: e.durationMs,
    ...(finite(e.status, 999) && e.status > 0 ? { status: e.status } : {}),
    ...(typeof e.cached === 'boolean' ? { cached: e.cached } : {}),
  };
}

/** The preview origin messages must come from: one origin, or a test (a runtime with per-application origins has several). */
export type PreviewOriginMatch = string | ((origin: string) => boolean);

const LEVELS = new Set<string>(['log', 'info', 'warn', 'error', 'debug']);

/**
 * The preview page a window message came from, when it is one of THIS runtime's:
 * sent from the preview origin, by a page under `base` ON THAT SAME ORIGIN (the
 * `href` a message claims is the app's word; `event.origin` is the browser's,
 * so application A cannot pass its errors or console off as B's), carrying
 * `nonce` when the runtime has one. Undefined otherwise.
 */
export function previewPageOf(event: MessageEvent, origin: PreviewOriginMatch, base: string, nonce?: string): URL | undefined {
  const data = event.data as { href?: unknown; nonce?: unknown } | null;
  const href = data?.href;
  if (typeof href !== 'string' || !(typeof origin === 'string' ? event.origin === origin : origin(event.origin))) return undefined;
  if (nonce !== undefined && data!.nonce !== nonce) return undefined;
  try {
    const page = new URL(href);
    if (page.origin !== event.origin) return undefined; // a page claiming another origin's address
    return page.pathname.startsWith(base) ? page : undefined; // else: another runtime's preview
  } catch {
    return undefined;
  }
}

/**
 * The host's own bound on violations (the page script dedupes and caps too, but
 * the page is the app's and may post anything): each (page, directive, blocked
 * origin) passes once, at most `CSP_VIOLATION_LIMIT` per page and
 * {@link CSP_VIOLATION_RUNTIME_LIMIT} in all. A page is its origin and path —
 * a query or hash never makes it a new page. Memory is bounded by the total cap.
 */
function violationGate(): (page: URL, violation: PreviewCspViolation) => boolean {
  const seen = new Set<string>();
  const perPage = new Map<string, number>();
  return (page, violation) => {
    if (seen.size >= CSP_VIOLATION_RUNTIME_LIMIT) return false;
    const pageKey = page.origin + page.pathname;
    const key = `${pageKey} ${violation.directive} ${violation.blockedOrigin}`;
    const count = perPage.get(pageKey) ?? 0;
    if (seen.has(key) || count >= CSP_VIOLATION_LIMIT) return false;
    seen.add(key);
    perPage.set(pageKey, count + 1);
    return true;
  };
}

function subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

export function listenToPreview(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, origin: PreviewOriginMatch, base: string, nonce?: string): PreviewMessages {
  const errors = new Set<(error: PreviewError) => void>();
  const consoles = new Set<(message: PreviewConsoleMessage) => void>();
  const violations = new Set<(violation: PreviewCspViolation) => void>();
  const timings = new Set<(timing: PreviewTiming) => void>();
  const admitViolation = violationGate();

  const onMessage = (event: MessageEvent) => {
    const page = previewPageOf(event, origin, base, nonce);
    if (!page) return;
    const data = event.data as { type?: unknown; href: string; message?: unknown; stack?: unknown; source?: unknown; level?: unknown; text?: unknown };
    if (data.type === ERROR_MESSAGE_TYPE) {
      const stack = typeof data.stack === 'string' ? data.stack : undefined;
      const { message, code } = previewErrorText(String(data.message ?? ''), stack);
      // A bridge from before `source` existed only reported uncaught errors and rejections.
      const source = typeof data.source === 'string' && SOURCES.has(data.source) ? (data.source as PreviewErrorSource) : 'error';
      const error: PreviewError = { message, stack, href: data.href, source, ...(code ? { code } : {}) };
      for (const listener of errors) listener(error);
    } else if (data.type === CONSOLE_MESSAGE_TYPE && typeof data.level === 'string' && LEVELS.has(data.level)) {
      const message: PreviewConsoleMessage = { level: data.level as ConsoleLevel, text: String(data.text ?? ''), href: data.href };
      for (const listener of consoles) listener(message);
    } else if (data.type === CSP_VIOLATION_MESSAGE_TYPE) {
      const violation = cspViolationOf(data as Parameters<typeof cspViolationOf>[0]);
      if (violation && admitViolation(page, violation)) for (const listener of violations) listener(violation);
    } else if (data.type === TIMING_MESSAGE_TYPE) {
      const entries = (data as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(0, TIMING_BATCH_SIZE)) {
        const timing = previewTimingOf(entry);
        if (timing) for (const listener of timings) listener(timing);
      }
    }
  };
  target.addEventListener('message', onMessage as EventListener);

  return {
    onError: (listener) => subscribe(errors, listener),
    onConsole: (listener) => subscribe(consoles, listener),
    onCspViolation: (listener) => subscribe(violations, listener),
    onTiming: (listener) => subscribe(timings, listener),
    dispose() {
      target.removeEventListener('message', onMessage as EventListener);
      errors.clear();
      consoles.clear();
      violations.clear();
      timings.clear();
    },
  };
}
