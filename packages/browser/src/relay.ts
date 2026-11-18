/**
 * The relay page's script (bundled inline into dist/relay.html). Served on the
 * preview origin and framed, hidden, by the host page, it registers the preview
 * worker on ITS origin and passes ports, re-attach requests and reloads between
 * the two. See `relayTransport`.
 *
 * Whoever may frame this page may drive it, so the server that hosts relay.html
 * must send `Content-Security-Policy: frame-ancestors <host origin>` (the host
 * only) with `connect-src 'none'` and a restrictive `default-src` (README ›
 * Preview origin headers): the relay itself never fetches, so a preview that
 * scripts it gains no egress. It refuses to run unframed (a top-level or opened
 * window), and the worker accepts attaches only from it as a nested frame.
 *
 * The worker's configuration (egress, report endpoint, policy id) comes from
 * this page's own URL, which the host set, into the worker URL it registers
 * (`relayConfig`) — never from a message.
 */
import { REATTACH, RELAY_ATTACH, RELAY_READY, RELAY_REATTACH, RELAY_SPAWN, RELAY_UPDATE, attachMessageOf } from './protocol.js';
import { bridgeWorker, relayWorkerUrl } from './relayWorker.js';
import { relayServiceWorkerUrl } from './relayConfig.js';
import type { PreviewUpdate } from '@seanhogg/builderforce-webcontainers-core';
import { broadcastUpdate, waitForActive } from './worker.js';

const host = window.parent;

async function start(): Promise<void> {
  if (host === window) throw new Error('The preview relay only runs framed by its host page.');
  const container = navigator.serviceWorker;
  if (!container) throw new Error('Service workers are unavailable on the preview origin.');
  // `mode=relay` tells the worker to accept ATTACH only from this exact relay page (not any same-origin page).
  const registration = await container.register(relayServiceWorkerUrl(location.href), { scope: './' });
  await waitForActive(registration);

  container.addEventListener('message', (event) => {
    if (event.data?.type === REATTACH && typeof event.data.id === 'string') host.postMessage({ type: RELAY_REATTACH, id: event.data.id }, '*');
  });

  addEventListener('message', (event) => {
    if (event.source !== host) return;
    const data = event.data as { type?: string; id?: unknown; base?: unknown; update?: PreviewUpdate; nonce?: unknown; previous?: unknown } | null;
    if (data?.type === RELAY_ATTACH && typeof data.id === 'string' && event.ports[0]) {
      // The host's attach nonce goes on as it came; the worker judges it (a malformed one is refused there). Nothing else does.
      registration.active?.postMessage(attachMessageOf({ id: data.id, nonce: data.nonce, previous: data.previous }), [event.ports[0]]);
    } else if (data?.type === RELAY_UPDATE && typeof data.base === 'string') {
      broadcastUpdate(data.base, data.update ?? { type: 'reload' });
    } else if (data?.type === RELAY_SPAWN && event.ports[0]) {
      // Process code runs HERE, on the preview origin, never on the host's — Node's, Python's, PHP's or .NET's.
      const spawn = data as { worker?: unknown; policy?: unknown };
      const script = relayWorkerUrl(spawn.worker, spawn.policy, location.href);
      bridgeWorker(event.ports[0], new Worker(script.url, { name: script.name }));
    }
  });

  host.postMessage({ type: RELAY_READY }, '*');
}

start().catch((error: unknown) => {
  host.postMessage({ type: RELAY_READY, error: error instanceof Error ? error.message : String(error) }, '*');
});
