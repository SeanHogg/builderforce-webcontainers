/**
 * Where previews may be served from (make.md › PRD 31 §4 W10, controls 1 and 10),
 * decided on the host page before anything boots. Pure: no DOM, so the rules are
 * tested directly.
 *
 * - Control 10: a preview never shares the embedding page's origin. Same-origin
 *   mode (`serviceWorkerUrl`) and a relay served from the page's own origin are
 *   refused with `ingress.same_origin_refused` — unless the embedder opts out by
 *   name (`unprotectedSameOrigin: true`), which is never a default.
 * - Control 1: with `previewOrigin`, every application gets its own origin, built
 *   from a key hashed from (runtime id, application id) so it is unique across
 *   projects in one browser profile; the
 *   computed origin must be a bare https origin (no path, query, fragment or
 *   credentials), distinct from the page's, from the shared preview origin and
 *   from every other application's — else `ingress.preview_origin_invalid`.
 * - Without `previewOrigin`, applications share one preview origin (storage,
 *   Cache Storage, BroadcastChannel, worker scope): a console warning once per
 *   page and an `ingress.shared_preview_origin` event per runtime say so.
 */
import { hashAlgorithm, type ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';

/** A boot or routing decision the Security Shield refused; `reason` is the contract, `message` is for logs. */
export class PreviewShieldError extends Error {
  readonly code = 'EBFWC_SHIELD';
  constructor(
    readonly reason: ShieldReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewShieldError';
  }
}

/** A Security Shield event the runtime reports (telemetry; enforcement never depends on it). */
export interface ShieldEvent {
  reason: ShieldReasonCode;
  /** Plain explanation for logs (not localized; `reason` is the contract). */
  message: string;
  applicationId?: string;
  origin?: string;
}

/** Where shield events leave the runtime (the embedding product maps reason codes to its own records). Its failures are ignored. */
export interface ShieldEventSink {
  emit(event: ShieldEvent): void;
}

/** Who a preview origin is for: the runtime (its `id`, the project) and the application in it. */
export interface PreviewOriginContext {
  runtimeId: string;
  applicationId: string;
}

/**
 * An application's preview origin from its `key` (`previewOriginKey`: a DNS
 * label unique per runtime and application), e.g.
 * `(key) => \`https://${key}.preview.example.com\``. Must return a bare https
 * origin. Build it from `key`, never from the raw ids in `context`: those are
 * user-controlled names, and only the key is unique across every project in a
 * browser profile.
 */
export type PreviewOriginOption = (key: string, context: PreviewOriginContext) => string;

const encoder = new TextEncoder();

/**
 * The DNS label an application's preview origin is built from: the first 128
 * bits of SHA-256 over (runtime id, application id), as 32 lowercase hex
 * characters. Unique across projects in one browser profile as long as runtime
 * ids are (pass the project id as `id`); never a raw, user-controlled name.
 */
export function previewOriginKey(runtimeId: string, applicationId: string): string {
  const digest = hashAlgorithm('sha256').digest(encoder.encode(`bfwc-preview-origin\u0000${runtimeId}\u0000${applicationId}`));
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A `previewOrigin` from a template: `{key}` is replaced by the application's `previewOriginKey` (`https://{key}.preview.example.com`). */
export function previewOriginTemplate(template: string): PreviewOriginOption {
  if (!template.includes('{key}')) throw new PreviewShieldError('ingress.preview_origin_invalid', `Preview origin template "${template}" has no {key}.`);
  return (key) => template.split('{key}').join(key);
}

/** A bare origin (`https://host[:port]`) when `value` is exactly one; else null. */
function bareOrigin(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
    return bare && (value === url.origin || value === `${url.origin}/`) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Check an application's computed preview origin: a bare https origin, none of
 * `refused` (the page's own origin, the shared preview origin, other
 * applications' origins). Returns it normalized; throws `PreviewShieldError`
 * (`ingress.preview_origin_invalid`) otherwise.
 */
export function validatePreviewOrigin(value: unknown, applicationId: string, refused: Iterable<string>): string {
  const url = bareOrigin(value);
  const invalid = (why: string) => new PreviewShieldError('ingress.preview_origin_invalid', `The preview origin for application "${applicationId}" (${String(value)}) ${why}.`);
  if (!url) throw invalid('is not a bare origin (scheme, host and port only)');
  if (url.protocol !== 'https:') throw invalid('is not https');
  for (const origin of refused) if (origin === url.origin) throw invalid("is the page's own origin, the shared preview origin or another application's");
  return url.origin;
}

/** What `startPreviewRuntime` was asked for, as the boot check reads it. */
export interface PreviewOriginRequest {
  /** Same-origin mode's worker URL (no relay). */
  serviceWorkerUrl?: string;
  relayUrl?: string;
  /** The named opt-out from control 10. */
  unprotectedSameOrigin?: boolean;
  previewOrigin?: PreviewOriginOption;
}

let sharedOriginWarned = false;

/** Report one shield event: telemetry fails open. */
export function emitShieldEvent(sink: ShieldEventSink | undefined, event: ShieldEvent): void {
  try {
    sink?.emit(event);
  } catch {
    // Telemetry never changes the decision.
  }
}

/**
 * Control 10 at boot: throws `PreviewShieldError` (`ingress.same_origin_refused`)
 * when the preview would share `embeddingOrigin`, unless `unprotectedSameOrigin`
 * is set. Warns (once per page) and reports when every application will share
 * one preview origin. Returns the relay's origin in relay mode.
 */
export function checkPreviewOrigins(request: PreviewOriginRequest, embeddingOrigin: string, sink?: ShieldEventSink): string | undefined {
  const relayOrigin = request.relayUrl ? new URL(request.relayUrl, embeddingOrigin).origin : undefined;
  const shared = relayOrigin === undefined || relayOrigin === embeddingOrigin;
  if (shared && !request.unprotectedSameOrigin) {
    throw new PreviewShieldError(
      'ingress.same_origin_refused',
      relayOrigin === undefined
        ? 'Same-origin previews are refused: serve the relay from a separate origin (`relayUrl`), or opt out by name with `unprotectedSameOrigin: true`.'
        : `The preview relay (${relayOrigin}) is on this page's own origin: serve it from a separate origin.`,
    );
  }
  if (request.previewOrigin && relayOrigin === undefined) {
    throw new PreviewShieldError('ingress.preview_origin_invalid', '`previewOrigin` needs relay mode (`relayUrl`): each application is served by its own relay.');
  }
  if (!request.previewOrigin) {
    const message = shared
      ? `Previews run on this page's own origin (${embeddingOrigin}) — \`unprotectedSameOrigin\` is set.`
      : `Every application shares the preview origin ${relayOrigin}; set \`previewOrigin\` to give each application its own.`;
    if (!sharedOriginWarned) {
      sharedOriginWarned = true;
      console.warn(`[bfwc] ${message}`);
    }
    emitShieldEvent(sink, { reason: 'ingress.shared_preview_origin', message, origin: relayOrigin ?? embeddingOrigin });
  }
  return relayOrigin;
}

/** Tests only: forget that the shared-origin warning was shown. */
export function resetSharedOriginWarning(): void {
  sharedOriginWarned = false;
}
