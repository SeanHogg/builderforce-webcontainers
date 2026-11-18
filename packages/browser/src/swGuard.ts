/**
 * The preview service worker's ingress guard: the attach decision (rules in
 * `swBindings`) and which preview each client may reach. Pure (no worker
 * globals), so it is tested with fakes.
 *
 * A client is never bound by "first seen": a client the worker does not know
 * (new, or forgotten after a restart or eviction) is looked up (`clients.get`)
 * and judged by its own type and URL, so inherited-controller clients
 * (about:blank, srcdoc, blob: workers) and process workers cannot pick a preview
 * to reach.
 *
 * Within one origin this is defence in depth: a preview document can script
 * its sibling relay frame (`parent[i]`) and act as it, or `history.pushState` to
 * another preview's path before a forgotten client is looked up again. The
 * boundary between applications is per-application origins (`previewOrigin`,
 * W10 control 1), with the page serving an application's ports only through its
 * own origin (see `swBindings` for the attach side).
 */
import {
  ATTACH_MESSAGES,
  createAttachOwners,
  createRecentMap,
  httpPath,
  isAttacher,
  type AttachClient,
  type AttachMode,
  type AttachRefusal,
  type IngressRejection,
} from './swBindings.js';
import { PREVIEW_ID, attachProofOf, previewPrefix, type AttachProof } from './protocol.js';

/** How long a host page's "may reach any preview" (or a "nothing") verdict is reused before `clients.get` is asked again. */
const VERDICT_TTL_MS = 5_000;

/** What a client may reach: one preview, any (a host or relay page, unbound), or nothing. */
export type ClientScope = { preview: string } | 'any' | 'none';

/**
 * Judge a client the worker does not know. A window, worker or shared worker
 * served from `<prefix><id>/…` belongs to that preview (a worker there runs that
 * preview's own script). An http(s) window that may attach (the relay page; in
 * same-origin mode also a host page outside the preview namespace) may reach any
 * preview. Everything else reaches nothing: an unknown client, process workers
 * beside the worker, and about:/blob:/data: clients.
 *
 * Known limitation until control 1: about:/blob:/srcdoc clients inherit the
 * controller from whoever made them, and the worker cannot tell whose they are,
 * so they are refused — including legitimate ones such as Vite inline workers
 * (`?worker&inline`, blob: URLs), Monaco's blob: workers and PDF.js's worker
 * when loaded from a blob, whenever they fetch a preview URL.
 */
export function scopeOfClient(
  client: AttachClient | undefined,
  scopePath: string,
  mode: AttachMode,
  previewIdOf: (url: URL) => string | null,
): ClientScope {
  if (!client || httpPath(client.url) === null) return 'none';
  const id = previewIdOf(new URL(client.url));
  if (id !== null && ['window', 'worker', 'sharedworker'].includes(client.type)) return { preview: id };
  return isAttacher(client, scopePath, mode) ? 'any' : 'none';
}

/** The parts of a fetch the pass-through decision reads. */
export interface LookupRequest {
  method: string;
  /** `navigate` for navigations, which are never intercepted here. */
  mode?: string;
}

export interface IngressGuardOptions {
  scopePath: string;
  attachMode?: AttachMode;
  /** `clients.get(id)`. Without it every unbound client is refused and a live attach binding never moves. */
  getClient?(clientId: string): Promise<AttachClient | undefined>;
  onReject?(rejection: IngressRejection): void;
  /** The preview id a URL is served for (the router's `match`), or null. */
  previewIdOf(url: URL): string | null;
  /** Told when a client is bound from its own URL (after a lookup), so routing state can be rebuilt. */
  onIdentified?(clientId: string, url: URL): void;
  /** Whether the router already maps this client's absolute URLs to a virtual server. */
  hasRemap?(clientId: string): boolean;
  /** The clock for the verdict cache (tests). */
  now?(): number;
}

/** The attach and client-binding decisions, reporting every refusal. */
export function createIngressGuard(options: IngressGuardOptions) {
  const { scopePath, getClient } = options;
  const mode = options.attachMode ?? 'same-origin';
  const prefix = previewPrefix(scopePath);
  const now = options.now ?? Date.now;
  const owners = createAttachOwners(getClient ? async (clientId) => (await getClient(clientId)) !== undefined : async () => true);
  /** Client id → the preview it was served for. */
  const bindings = createRecentMap<string>();
  /** Client id → until when its 'any' (host page) or 'none' verdict is reused. */
  const verdicts = createRecentMap<{ scope: 'any' | 'none'; until: number }>();

  async function lookup(clientId: string): Promise<AttachClient | undefined> {
    try {
      return await getClient?.(clientId);
    } catch {
      return undefined; // an unknown client reaches nothing
    }
  }

  function report(rejection: IngressRejection): void {
    try {
      options.onReject?.(rejection);
    } catch {
      // telemetry never changes the decision
    }
  }

  /** Whether `client` may attach ports — and so be asked to re-attach (never a preview document). */
  const mayAttach = (client: AttachClient) => isAttacher(client, scopePath, mode);

  /**
   * Whether `client` may attach `id` with `proof`: a well-formed nonce, from an
   * attacher, for an id that is free, already theirs (proven by the nonce of their
   * last attach), or whose owner is gone. Preview ids must therefore be unique per tab:
   * a second tab attaching the same id (a fixed `options.id`) is refused while
   * the first is open.
   */
  async function checkAttach(id: string, client: AttachClient | null | undefined, proof: AttachProof | null | undefined): Promise<boolean> {
    let detail: AttachRefusal | null;
    const valid = attachProofOf(proof);
    if (!PREVIEW_ID.test(id)) detail = 'bad_id';
    else if (!valid) detail = 'bad_nonce';
    else if (!client || !mayAttach(client)) detail = 'not_attacher';
    else detail = await owners.claim(id, client.id, valid);
    if (!detail) return true;
    report({ reason: 'ingress.attach_rejected', id, clientId: client?.id, detail, message: ATTACH_MESSAGES[detail](id) });
    return false;
  }

  /** What `clientId` may reach: its binding, a cached verdict, or a fresh lookup by its own type and URL. */
  async function identify(clientId: string): Promise<ClientScope> {
    const bound = bindings.get(clientId);
    if (bound !== undefined) return { preview: bound };
    const cached = verdicts.get(clientId);
    if (cached && cached.until > now()) return cached.scope;
    const client = await lookup(clientId);
    const scope = scopeOfClient(client, scopePath, mode, options.previewIdOf);
    if (typeof scope === 'string') verdicts.set(clientId, { scope, until: now() + VERDICT_TTL_MS });
    else {
      bindings.set(clientId, scope.preview);
      options.onIdentified?.(clientId, new URL(client!.url));
    }
    return scope;
  }

  /**
   * Whether a request for preview `id` may proceed. A client the guard does not
   * know is judged by `identify`, never bound to whatever it asks for first. A
   * request with no client (a navigation: browsers report `clientId` "" for
   * those, so the page that starts one is never judged by it) goes ahead, and
   * binds the document or worker it creates.
   */
  async function checkClient(id: string, clientId: string | undefined, resultingClientId: string | undefined): Promise<boolean> {
    if (clientId) {
      const scope = await identify(clientId);
      if (scope === 'none' || (scope !== 'any' && scope.preview !== id)) {
        report({ reason: 'ingress.client_not_bound', id, clientId });
        return false;
      }
    }
    if (resultingClientId) bindings.set(resultingClientId, id);
    return true;
  }

  /**
   * Whether a request the router could not match should be held while its client
   * is judged: it may come from a virtual-server page the worker forgot (a
   * restart), whose absolute URLs (`/style.css`) need the remap back. Only a GET
   * or HEAD subresource request, same-origin, outside the preview prefix, from a
   * client never judged before. Everything else is left to the network untouched.
   *
   * Trade-off: a non-GET request is never held (the worker would have to replay
   * its body), so after a restart a forgotten `__port` page's first `POST /api`
   * goes to the network (and fails) until one GET from that page re-judges it.
   */
  function needsLookup(url: URL, clientId: string | undefined, origin: string, request: LookupRequest): boolean {
    if (!clientId || request.mode === 'navigate') return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    if (url.origin !== origin || url.pathname.startsWith(prefix)) return false;
    return !options.hasRemap?.(clientId) && !bindings.has(clientId) && !verdicts.has(clientId);
  }

  return { mayAttach, checkAttach, checkClient, identify, needsLookup, report, release: owners.release };
}
