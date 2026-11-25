/**
 * Security Shield identity contract (make.md › PRD 31 §4 W10, principle 3).
 *
 * Identity is ASSIGNED by the runtime on the page side at spawn, never claimed by
 * the process: env vars (`BUILDERFORCE_SERVICE`), Postgres `application_name` and
 * anything else app code can set are telemetry at most. Every page-side chokepoint
 * (PortRegistry, ConnectionRelay, the database gateway, FsSync, spawnChild) decides
 * against this record.
 */

/** Who a process, port or connection belongs to. */
export interface SecurityContext {
  /** The application (`startApplicationRuntime`) — or `WORKSPACE_APPLICATION` for terminal / install / instant preview. */
  readonly applicationId: string;
  /** The service within the application — or `WORKSPACE_SERVICE`. */
  readonly serviceId: string;
  readonly processId?: number;
  readonly requestId?: string;
  readonly connectionId?: string;
}

/** Processes started outside any application (terminal, `npm install`, instant preview). Never `platform`. */
export const WORKSPACE_APPLICATION = 'workspace';
export const WORKSPACE_SERVICE = 'workspace';

/** Reserved for the host's own calls (`runtime.request` from the embedding page). App code can never hold it. */
export const PLATFORM_APPLICATION = 'platform';
export const PLATFORM_SERVICE = 'platform';

export const WORKSPACE_CONTEXT: SecurityContext = Object.freeze({ applicationId: WORKSPACE_APPLICATION, serviceId: WORKSPACE_SERVICE });
export const PLATFORM_CONTEXT: SecurityContext = Object.freeze({ applicationId: PLATFORM_APPLICATION, serviceId: PLATFORM_SERVICE });

/**
 * Whether `applicationId` names an application (`startApplicationRuntime`), not
 * the workspace or the platform: the host side's two identities. The one
 * predicate every chokepoint asks (preview origins, database credentials).
 */
export function isApplicationId(applicationId: string | undefined): applicationId is string {
  return applicationId !== undefined && applicationId !== WORKSPACE_APPLICATION && applicationId !== PLATFORM_APPLICATION;
}

/** Same (application, service) — process/request/connection ids are ignored. */
export function sameService(a: SecurityContext, b: SecurityContext): boolean {
  return a.applicationId === b.applicationId && a.serviceId === b.serviceId;
}

/** Stable reason codes the runtime emits; the embedding product maps them to localized copy. */
export type ShieldReasonCode =
  | 'port.not_owner'
  | 'port.edge_not_declared'
  | 'db.auth_failed'
  | 'db.not_owner'
  | 'db.service_not_allowed'
  | 'process.spawn_quota'
  | 'process.depth_quota'
  | 'fs.outside_app'
  | 'fs.protected_path'
  | 'fs.invalid_op'
  | 'ingress.body_too_large'
  | 'ingress.client_not_bound'
  | 'ingress.attach_rejected'
  /** The preview would share the embedding page's origin (same-origin mode, or a relay on the page's own origin): boot refused. */
  | 'ingress.same_origin_refused'
  /** A computed per-application preview origin is not an https origin distinct from the page's and every other application's. */
  | 'ingress.preview_origin_invalid'
  /** A request reached an application's port through a preview origin that is not that application's. */
  | 'ingress.app_origin_mismatch'
  /** An application started with no `previewOrigin` and no named opt-out (`sharedPreviewOrigin: 'unprotected'`): refused. */
  | 'ingress.app_origin_required'
  /** Telemetry, not a refusal: an application started on the shared preview origin under the named opt-out. */
  | 'ingress.shared_preview_origin'
  /**
   * A process of one application announced a dev-server handoff while another application's handoff is live:
   * refused, so the first keeps the shared preview (and its frontend identity) until it ends.
   */
  | 'ingress.handoff_conflict'
  /** The embedder's egress policy id for an application is malformed: dropped, so its Workers get the most restrictive policy. */
  | 'egress.policy_invalid'
  /** A message to or from a process Worker could not be delivered across origins (`messageerror`): the process was ended. */
  | 'process.message_undeliverable'
  /** An agent called an environment tool outside its allowlist (or a mutating one without an idempotency key): refused. */
  | 'agent.tool_not_allowed'
  /** An agent's environment file path was absolute or had a `..` segment: refused. */
  | 'agent.path_invalid'
  /** An agent asked to fetch from a service that is not one of its environment's own: refused. */
  | 'agent.service_not_allowed'
  /** The code scanner's verdict (block / quarantine) refused an install, a write or a spawn of malicious code. */
  | 'code.blocked'
  /** Telemetry: the code scanner could not finish a scan. Refuses only when the embedder's policy is `refuse`. */
  | 'code.scan_incomplete';

/** A page-side decision; `reject` carries the reason the caller surfaces (ECONNREFUSED, 403, EACCES…). */
export type ShieldDecision = { readonly allow: true } | { readonly allow: false; readonly reason: ShieldReasonCode };

export const ALLOW: ShieldDecision = Object.freeze({ allow: true });
export function deny(reason: ShieldReasonCode): ShieldDecision {
  return { allow: false, reason };
}
