/**
 * Who may hand the preview service worker a port (the attacher rules and the
 * preview id → attaching client binding), and the bounded maps the guard
 * (`swGuard`) keeps its client bindings in. Pure (no worker globals), so the
 * rules are tested with fakes. Decided on the worker side because preview
 * documents run the app's code and nothing they say is trusted. A live attach
 * binding is never replaced by another client; it moves only when the bound
 * client is gone (its tab closed).
 *
 * Within one origin these are defence in depth, not the boundary: a preview
 * document shares its origin with the relay frame and process Workers serving
 * it, so it can script the sibling relay (`parent[i]`) — listen to its messages,
 * post as it. The attach nonce stops a script that never saw the host's
 * messages from rebinding a preview; the boundary between applications is the
 * origin itself (W10 control 1, `previewOrigin`: each application's previews,
 * relay and Workers on their own origin, so the most a preview can capture is
 * its own application). Without `previewOrigin`, applications share the origin
 * and so this hole (the runtime warns).
 */
import type { ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
import { previewPrefix, type AttachProof } from './protocol.js';

/** A request or attach the worker refused (telemetry; never a reason to allow). */
export interface IngressRejection {
  reason: ShieldReasonCode;
  /** The preview id asked for. */
  id: string;
  clientId?: string;
  /** Why an attach was refused (`ingress.attach_rejected` only). */
  detail?: AttachRefusal;
  /** A plain explanation for logs (not localized; the reason code is the contract). */
  message?: string;
}

/**
 * `bad_id`: not a preview id; `bad_nonce`: no well-formed attach nonce; `not_attacher`: not the relay/host page;
 * `stale_nonce`: the bound client re-attached without the nonce of its last attach; `duplicate_id`: another open tab attached it.
 */
export type AttachRefusal = 'bad_id' | 'bad_nonce' | 'not_attacher' | 'stale_nonce' | 'duplicate_id';

export const ATTACH_MESSAGES: Record<AttachRefusal, (id: string) => string> = {
  bad_id: (id) => `"${id}" is not a preview id.`,
  bad_nonce: (id) => `preview id '${id}' was offered without a well-formed attach nonce.`,
  not_attacher: (id) => `preview id '${id}' was offered by a page that may not attach previews (only the relay or host page may).`,
  stale_nonce: (id) => `preview id '${id}' was re-attached without the nonce of its current attach.`,
  duplicate_id: (id) => `preview id '${id}' is already attached by another open tab; preview ids must be unique per tab.`,
};

/** A client as the worker sees `event.source` or `clients.get`. */
export interface AttachClient {
  id: string;
  url: string;
  /** `window`, `worker` or `sharedworker`. */
  type: string;
}

/**
 * Who registered the worker. `relay`: the relay page registers `sw.js?mode=relay`
 * with scope './', and only that exact page (`<scope>relay.html`) may attach.
 * `same-origin`: the host page registers it and attaches itself, from anywhere
 * outside the preview namespace.
 */
export type AttachMode = 'relay' | 'same-origin';

/** The `mode` a worker script URL carries (`sw.js?mode=relay`). */
export function attachModeOf(scriptUrl: string): AttachMode {
  try {
    return new URL(scriptUrl).searchParams.get('mode') === 'relay' ? 'relay' : 'same-origin';
  } catch {
    return 'same-origin';
  }
}

/** The pathname of an http(s) URL; null for about:, blob:, data: and anything unparsable. */
export function httpPath(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/**
 * Whether `url` is the relay page this worker serves: `relay.html` resolved
 * against the scope, exactly as the relay registered its scope ('./' beside
 * itself). Not `previewPrefix`: under a root scope the relay is `/relay.html`,
 * outside the `/__bfwc/` preview prefix.
 */
export function isRelayPage(url: string, scopePath: string): boolean {
  return httpPath(url) === new URL('relay.html', new URL(scopePath, 'https://scope.invalid')).pathname;
}

/**
 * Whether a page at `url` may attach ports (see `AttachMode`). Never an
 * about:/blob:/data: document, and never one under the preview prefix (a preview
 * document running app code) — except the relay page itself.
 */
export function isAttacherUrl(url: string, scopePath: string, mode: AttachMode): boolean {
  const path = httpPath(url);
  if (path === null) return false;
  if (isRelayPage(url, scopePath)) return true;
  if (mode === 'relay') return false;
  return !path.startsWith(previewPrefix(scopePath));
}

/** Whether `client` may attach ports or be asked to re-attach. */
export function isAttacher(client: AttachClient, scopePath: string, mode: AttachMode): boolean {
  return client.type === 'window' && isAttacherUrl(client.url, scopePath, mode);
}

/**
 * Preview id → the client that attached it and the nonce of that attach.
 * `clientAlive` asks the browser whether a client still exists; an error is
 * treated as alive, so a failed check never hands a live preview to a new client.
 *
 * The bound client may re-attach only by presenting its current nonce as
 * `previous` (a fresh port after a worker timeout, a REATTACH). A binding whose
 * client is gone moves to any attacher: the dead client's nonce died with it. A
 * worker restart forgets every binding, so the first attach after it is taken
 * on the attacher rules alone.
 */
export function createAttachOwners(clientAlive: (clientId: string) => Promise<boolean>) {
  const owners = new Map<string, { clientId: string; nonce: string }>();
  /** Bumped on every change to an id's owner, so a claim that awaited sees any move. */
  const generations = new Map<string, number>();

  function set(id: string, clientId: string, nonce: string): void {
    owners.set(id, { clientId, nonce });
    generations.set(id, (generations.get(id) ?? 0) + 1);
  }

  async function isAlive(clientId: string): Promise<boolean> {
    try {
      return await clientAlive(clientId);
    } catch {
      return true; // fail closed: keep the existing binding
    }
  }

  /** Bind `id` to `clientId` with `proof.nonce` if it is free, theirs (proven by `proof.previous`), or its owner is gone; else why not. */
  async function claim(id: string, clientId: string, proof: AttachProof): Promise<AttachRefusal | null> {
    for (;;) {
      const owner = owners.get(id);
      if (owner === undefined) {
        set(id, clientId, proof.nonce);
        return null;
      }
      if (owner.clientId === clientId) {
        if (proof.previous !== owner.nonce) return 'stale_nonce';
        set(id, clientId, proof.nonce);
        return null;
      }
      const generation = generations.get(id);
      if (await isAlive(owner.clientId)) return 'duplicate_id';
      // Judge again if another attach moved the binding while we asked.
      if (generations.get(id) !== generation) continue;
      set(id, clientId, proof.nonce);
      return null;
    }
  }

  function release(id: string): void {
    if (owners.delete(id)) generations.set(id, (generations.get(id) ?? 0) + 1);
  }

  return { claim, release, ownerOf: (id: string) => owners.get(id)?.clientId };
}

/** How many clients the worker remembers; a forgotten one is looked up again, never trusted. */
const CLIENT_CAP = 500;

/** A bounded map that forgets the least recently used entry first; a hit refreshes recency. */
export function createRecentMap<V>(cap = CLIENT_CAP) {
  const entries = new Map<string, V>();
  return {
    get(key: string): V | undefined {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key: string, value: V): void {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > cap) entries.delete(entries.keys().next().value!);
    },
    has: (key: string) => entries.has(key),
  };
}
