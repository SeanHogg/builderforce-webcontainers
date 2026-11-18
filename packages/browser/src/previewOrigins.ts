/**
 * One preview origin per application (make.md › PRD 31 §4 W10, control 1).
 *
 * The shared relay serves the workspace (terminal, installs, instant preview)
 * and the platform. With `previewOrigin` set, each application gets its own
 * relay — `relay.html` at the same path on the application's origin — so its
 * preview documents, process Workers, service worker scope, Cache Storage,
 * IndexedDB and BroadcastChannels live on an origin no other application shares.
 * A relay opens on the application's first process and closes when the
 * application ends.
 *
 * The origin a request came through must be its port owner's: the host serves an
 * application's ports only through that application's origin, and the shared
 * origin only the workspace's and the platform's (`mayServe`), so a preview
 * cannot reach another application's server through its own service worker.
 * Without `previewOrigin` every port is served everywhere, as before.
 */
import { PLATFORM_APPLICATION, WORKSPACE_APPLICATION, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { emitShieldEvent, previewOriginKey, validatePreviewOrigin, PreviewShieldError, type PreviewOriginOption, type ShieldEventSink } from './previewOrigin.js';
import type { PreviewTransport } from './transport.js';
import type { WorkerLike } from './node/processHost.js';
import type { WorkerKind } from './node/protocol.js';

export interface PreviewOriginsOptions {
  /** The shared relay (the workspace's and the platform's origin). */
  shared: PreviewTransport;
  /** The shared relay's URL; an application's relay is at the same path and query on its own origin. Required with `previewOrigin`. */
  relayUrl?: string;
  /** The embedding page's origin: never a preview origin. */
  embeddingOrigin: string;
  previewOrigin?: PreviewOriginOption;
  /**
   * The egress policy id each application's process Workers start under (an
   * opaque signed id the embedder minted; see `relayWorkerUrl`). Workspace
   * processes and warm spares made before an application is known get none: the
   * most restrictive policy. Must answer the same for an application every time
   * (its warm spares are kept per application, so per policy).
   */
  workerPolicy?: string | ((applicationId: string) => string | undefined);
  /** The runtime's id (the project): with the application id, it keys the application's origin (`previewOriginKey`). */
  runtimeId: string;
  /** Open (without waiting) the relay at a URL. */
  open(relayUrl: string): PreviewTransport;
  /** A relay was opened for `applicationId`: attach the runtime's previews to it. Returns what to undo when it closes. */
  onOpened?(transport: PreviewTransport, applicationId: string): () => void;
  sink?: ShieldEventSink;
}

interface AppOrigin {
  origin: string;
  relay?: { transport: PreviewTransport; detach(): void };
}

/** Whether `applicationId` is an application's (not the workspace's or the platform's). */
const isApplication = (applicationId: string | undefined): applicationId is string =>
  applicationId !== undefined && applicationId !== WORKSPACE_APPLICATION && applicationId !== PLATFORM_APPLICATION;

export function createPreviewOrigins(options: PreviewOriginsOptions) {
  const { shared } = options;
  const relay = new URL(options.relayUrl ?? '/', options.embeddingOrigin);
  const relayPath = relay.pathname + relay.search;
  const apps = new Map<string, AppOrigin>();
  const separate = (applicationId: string | undefined): applicationId is string => !!options.previewOrigin && isApplication(applicationId);

  /**
   * The origin `applicationId`'s previews and processes use: its own (computed
   * and validated on first use, then fixed) or the shared one. Throws
   * `PreviewShieldError` (`ingress.preview_origin_invalid`) for an invalid one.
   */
  function originOf(applicationId: string | undefined): string {
    if (!separate(applicationId)) return shared.origin;
    const known = apps.get(applicationId);
    if (known) return known.origin;
    const taken = [options.embeddingOrigin, shared.origin, ...[...apps.values()].map((app) => app.origin)];
    let origin: string;
    try {
      const context = { runtimeId: options.runtimeId, applicationId };
      origin = validatePreviewOrigin(options.previewOrigin!(previewOriginKey(options.runtimeId, applicationId), context), applicationId, taken);
    } catch (error) {
      const refusal =
        error instanceof PreviewShieldError ? error : new PreviewShieldError('ingress.preview_origin_invalid', `previewOrigin("${applicationId}") failed: ${error instanceof Error ? error.message : String(error)}`);
      emitShieldEvent(options.sink, { reason: refusal.reason, message: refusal.message, applicationId });
      throw refusal;
    }
    apps.set(applicationId, { origin });
    return origin;
  }

  /** The relay serving `applicationId` (opened on first use), or the shared one. */
  function transportFor(applicationId: string | undefined): PreviewTransport {
    if (!separate(applicationId)) return shared;
    const origin = originOf(applicationId);
    const app = apps.get(applicationId)!;
    if (!app.relay) {
      const transport = options.open(new URL(relayPath, origin).href);
      app.relay = { transport, detach: options.onOpened?.(transport, applicationId) ?? (() => undefined) };
    }
    return app.relay.transport;
  }

  /** The egress policy id for `applicationId`'s Workers; none for the workspace's and the platform's. */
  function policyOf(applicationId: string | undefined): string | undefined {
    if (!isApplication(applicationId)) return undefined;
    return typeof options.workerPolicy === 'function' ? options.workerPolicy(applicationId) : options.workerPolicy;
  }

  /**
   * A process Worker of `kind` for `applicationId`'s process (undefined: the
   * workspace's), started by the relay of its origin under its egress policy;
   * undefined when the shared transport cannot start Workers (same-origin mode).
   */
  const createWorker = shared.createWorker
    ? (kind: WorkerKind, applicationId?: string): WorkerLike => transportFor(applicationId).createWorker!(kind, policyOf(applicationId))
    : undefined;

  /** Whether a request that came through `origin` may reach a port `owner` listens on (no owner: nothing listens, the request 502s). */
  function mayServe(origin: string, owner: SecurityContext | undefined): boolean {
    if (!options.previewOrigin || !owner) return true;
    const expected = separate(owner.applicationId) ? apps.get(owner.applicationId)?.origin : shared.origin;
    return expected === origin;
  }

  /** Whether `origin` is one of this runtime's preview origins. */
  function accepts(origin: string): boolean {
    return origin === shared.origin || [...apps.values()].some((app) => app.origin === origin);
  }

  /** The shared relay and every application relay open now. */
  function transports(): PreviewTransport[] {
    return [shared, ...[...apps.values()].flatMap((app) => (app.relay ? [app.relay.transport] : []))];
  }

  /** `applicationId` ended: close its relay (its origin stays reserved for it, so it never moves to another application). */
  function release(applicationId: string): void {
    const app = apps.get(applicationId);
    if (!app?.relay) return;
    app.relay.detach();
    app.relay.transport.dispose();
    app.relay = undefined;
  }

  function dispose(): void {
    for (const applicationId of apps.keys()) release(applicationId);
    apps.clear();
  }

  return { enabled: !!options.previewOrigin, originOf, transportFor, createWorker, mayServe, accepts, transports, release, dispose };
}

export type PreviewOrigins = ReturnType<typeof createPreviewOrigins>;
