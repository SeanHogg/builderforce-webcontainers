/**
 * One preview origin per application (make.md › PRD 31 §4 W10, control 1). The
 * trust boundary is the application: its previews, relay frame and process
 * Workers share its origin, and nothing crosses between applications or between
 * an application and the workspace or the host.
 *
 * The shared relay serves the workspace (terminal, installs, instant preview)
 * and the platform. Each application gets its own relay — `relay.html` at the
 * same path on the application's origin — so its preview documents, process
 * Workers, service worker scope, Cache Storage, IndexedDB and BroadcastChannels
 * live on an origin no other application shares. A relay opens on the
 * application's first process and closes when the application ends, and its
 * origin is then forgotten (`accepts` no longer takes it); the origin key is
 * stable (`previewOriginKey` over the runtime id and the application's stable
 * id), so the application gets the same origin — and storage — next time.
 *
 * Per-application origins are MANDATORY for applications: without
 * `previewOrigin`, an application's first process is refused
 * (`ingress.app_origin_required`) unless the embedder opts out by name
 * (`sharedPreviewOrigin: 'unprotected'`), which warns and reports
 * `ingress.shared_preview_origin` on every application start. The workspace and
 * the platform are unaffected.
 *
 * Each application relay is framed at a URL carrying the application's
 * host-side configuration (`relayConfig`: egress, report endpoint, signed
 * policy id), which its service worker takes from its own script URL.
 *
 * The origin a request came through must be its port owner's (`mayServe`), so a
 * preview cannot reach another application's server through its own service worker.
 */
import { WORKSPACE_CONTEXT, isApplicationId, type SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { previewOriginKey, validatePreviewOrigin, PreviewShieldError, type PreviewOriginOption } from './previewOrigin.js';
import { relayConfigUrl } from './relayConfig.js';
import { WORKER_POLICY_ID, type UndeliverableListener } from './relayWorker.js';
import { applicationContext } from './security/securityEvent.js';
import type { ShieldReporter } from './security/shieldTelemetry.js';
import type { PreviewTransport } from './transport.js';
import type { WorkerLike } from './node/processHost.js';
import type { WorkerKind } from './node/protocol.js';

/** Where a custom `createWorker` must start an application's Worker: its preview origin, under its egress policy id. */
export interface WorkerTarget {
  origin: string;
  policy?: string;
}

/** An embedder's own Worker factory (`node.createWorker`): handed the target it must honour, never left to skip it. */
export type CustomWorkerFactory = (kind: WorkerKind, applicationId?: string, target?: WorkerTarget) => WorkerLike;

export interface PreviewOriginsOptions {
  /** The shared relay (the workspace's and the platform's origin). */
  shared: PreviewTransport;
  /** The shared relay's URL; an application's relay is at the same path and query on its own origin. Required with `previewOrigin`. */
  relayUrl?: string;
  /** The embedding page's origin: never a preview origin. */
  embeddingOrigin: string;
  previewOrigin?: PreviewOriginOption;
  /** The named opt-out from mandatory per-application origins: applications share the shared relay's origin. */
  sharedPreviewOrigin?: 'unprotected';
  /** The external sources an application's preview responses may reach (host-side; baked into its relay URL). */
  previewEgress?: readonly string[] | ((applicationId: string | undefined) => readonly string[]);
  /** Where CSP violations are reported (baked into each application relay's URL). */
  cspReportUrl?: string;
  /**
   * The egress policy id each application's process Workers start under (an
   * opaque signed id the embedder minted; see `relayWorkerUrl`). Workspace
   * processes and warm spares made before an application is known get none: the
   * most restrictive policy. Must answer the same for an application every time
   * (its warm spares are kept per application, so per policy). A malformed id is
   * dropped and reported (`egress.policy_invalid`).
   */
  workerPolicy?: string | ((applicationId: string) => string | undefined);
  /** The embedder's own Worker factory, if any: called with each application's `WorkerTarget`. */
  createWorker?: CustomWorkerFactory;
  /** The runtime's id (the project): with the application id, it keys the application's origin (`previewOriginKey`). */
  runtimeId: string;
  /** Open (without waiting) the relay at a URL. */
  open(relayUrl: string): PreviewTransport;
  /** A relay was opened for `applicationId`: attach the runtime's previews to it. Returns what to undo when it closes. */
  onOpened?(transport: PreviewTransport, applicationId: string): () => void;
  /** The runtime's Security Shield telemetry. */
  telemetry?: ShieldReporter;
}

interface AppOrigin {
  origin: string;
  relay?: { transport: PreviewTransport; detach(): void };
}

export function createPreviewOrigins(options: PreviewOriginsOptions) {
  const { shared } = options;
  const relay = new URL(options.relayUrl ?? '/', options.embeddingOrigin);
  const relayPath = relay.pathname + relay.search;
  const apps = new Map<string, AppOrigin>();
  /** Applications started on the shared origin under the opt-out (announced once per start). */
  const sharing = new Set<string>();
  /** Applications whose malformed policy id was already reported (once per start). */
  const badPolicies = new Set<string>();
  const separate = (applicationId: string | undefined): applicationId is string => !!options.previewOrigin && isApplicationId(applicationId);

  /** Report and throw `refusal`. */
  function refuse(refusal: PreviewShieldError, applicationId: string): never {
    options.telemetry?.report(refusal.reason, applicationContext(applicationId), { message: refusal.message }); // fails open
    throw refusal;
  }

  /** An application with no origin of its own: refused, or — under the named opt-out — announced and put on the shared origin. */
  function sharedFor(applicationId: string): string {
    if (options.sharedPreviewOrigin !== 'unprotected') {
      refuse(
        new PreviewShieldError('ingress.app_origin_required', `Application "${applicationId}" needs its own preview origin: set \`previewOrigin\`, or opt out by name with \`sharedPreviewOrigin: 'unprotected'\`.`),
        applicationId,
      );
    }
    if (!sharing.has(applicationId)) {
      sharing.add(applicationId);
      const message = `Application "${applicationId}" shares the preview origin ${shared.origin} with every other application (\`sharedPreviewOrigin: 'unprotected'\`).`;
      console.warn(`[bfwc] ${message}`);
      options.telemetry?.report('ingress.shared_preview_origin', applicationContext(applicationId), { message, origin: shared.origin }); // fails open
    }
    return shared.origin;
  }

  /**
   * The origin `applicationId`'s previews and processes use: its own (computed
   * and validated on first use in a start, then fixed) or the shared one for the
   * workspace and the platform. Throws `PreviewShieldError` for an application
   * with none (`ingress.app_origin_required`) or an invalid one (`ingress.preview_origin_invalid`).
   */
  function originOf(applicationId: string | undefined): string {
    if (!isApplicationId(applicationId)) return shared.origin;
    if (!options.previewOrigin) return sharedFor(applicationId);
    const known = apps.get(applicationId);
    if (known) return known.origin;
    const taken = [options.embeddingOrigin, shared.origin, ...[...apps.values()].map((app) => app.origin)];
    let origin: string;
    try {
      const context = { runtimeId: options.runtimeId, applicationId };
      origin = validatePreviewOrigin(options.previewOrigin(previewOriginKey(options.runtimeId, applicationId), context), applicationId, taken);
    } catch (error) {
      refuse(
        error instanceof PreviewShieldError ? error : new PreviewShieldError('ingress.preview_origin_invalid', `previewOrigin("${applicationId}") failed: ${error instanceof Error ? error.message : String(error)}`),
        applicationId,
      );
    }
    apps.set(applicationId, { origin });
    return origin;
  }

  /** The egress policy id for `applicationId`'s Workers: none for the workspace's and the platform's, nor for a malformed one (reported). */
  function policyOf(applicationId: string | undefined): string | undefined {
    if (!isApplicationId(applicationId)) return undefined;
    const policy = typeof options.workerPolicy === 'function' ? options.workerPolicy(applicationId) : options.workerPolicy;
    if (policy === undefined || WORKER_POLICY_ID.test(policy)) return policy;
    if (!badPolicies.has(applicationId)) {
      badPolicies.add(applicationId);
      options.telemetry?.report('egress.policy_invalid', applicationContext(applicationId), { message: 'The egress policy id is malformed: its Workers get the most restrictive policy.', length: String(policy).length });
    }
    return undefined;
  }

  const egressOf = (applicationId: string) => (typeof options.previewEgress === 'function' ? options.previewEgress(applicationId) : options.previewEgress);

  /** The relay serving `applicationId` (opened on first use, at a URL carrying its configuration), or the shared one. */
  function transportFor(applicationId: string | undefined): PreviewTransport {
    if (!separate(applicationId)) {
      originOf(applicationId); // an application without an origin of its own is refused (or announced) here too
      return shared;
    }
    const origin = originOf(applicationId);
    const app = apps.get(applicationId)!;
    if (!app.relay) {
      const url = relayConfigUrl(new URL(relayPath, origin), { egress: egressOf(applicationId), policy: policyOf(applicationId), report: options.cspReportUrl });
      const transport = options.open(url);
      app.relay = { transport, detach: options.onOpened?.(transport, applicationId) ?? (() => undefined) };
    }
    return app.relay.transport;
  }

  /** Reports a `messageerror` on one of `applicationId`'s Workers (the Worker itself fails as a process error). */
  const undeliverable =
    (applicationId: string | undefined): UndeliverableListener =>
    (message) =>
      options.telemetry?.report('process.message_undeliverable', isApplicationId(applicationId) ? applicationContext(applicationId) : WORKSPACE_CONTEXT, { message });

  /**
   * A process Worker of `kind` for `applicationId`'s process (undefined: the
   * workspace's), on its origin under its egress policy: started by that
   * origin's relay, or by the embedder's own factory, which is handed both.
   * Undefined when neither can start Workers (same-origin mode, no factory).
   */
  const createWorker: ((kind: WorkerKind, applicationId?: string) => WorkerLike) | undefined = options.createWorker
    ? (kind, applicationId) => options.createWorker!(kind, applicationId, { origin: transportFor(applicationId).origin, policy: policyOf(applicationId) })
    : shared.createWorker
      ? (kind, applicationId) => transportFor(applicationId).createWorker!(kind, policyOf(applicationId), undeliverable(applicationId))
      : undefined;

  /** Whether a request that came through `origin` may reach a port `owner` listens on (no owner: nothing listens, the request 502s). */
  function mayServe(origin: string, owner: SecurityContext | undefined): boolean {
    if (!owner) return true;
    const expected = separate(owner.applicationId) ? apps.get(owner.applicationId)?.origin : shared.origin;
    return expected === origin;
  }

  /** Whether `origin` is one of this runtime's live preview origins (an ended application's no longer is). */
  function accepts(origin: string): boolean {
    return origin === shared.origin || [...apps.values()].some((app) => app.origin === origin);
  }

  /** The shared relay and every application relay open now. */
  function transports(): PreviewTransport[] {
    return [shared, ...[...apps.values()].flatMap((app) => (app.relay ? [app.relay.transport] : []))];
  }

  /** `applicationId` ended: close its relay and forget its origin (its stable key gives it the same one when it starts again). */
  function release(applicationId: string): void {
    const app = apps.get(applicationId);
    apps.delete(applicationId);
    sharing.delete(applicationId);
    badPolicies.delete(applicationId);
    if (!app?.relay) return;
    app.relay.detach();
    app.relay.transport.dispose();
  }

  function dispose(): void {
    for (const applicationId of [...apps.keys()]) release(applicationId);
  }

  return { enabled: !!options.previewOrigin, originOf, transportFor, createWorker, mayServe, accepts, transports, release, dispose };
}

export type PreviewOrigins = ReturnType<typeof createPreviewOrigins>;
