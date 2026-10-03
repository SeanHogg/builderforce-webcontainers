/**
 * The relay page's script (bundled inline into dist/relay.html). Served on the
 * preview origin and framed, hidden, by the host page, it registers the preview
 * worker on ITS origin and passes ports, re-attach requests and reloads between
 * the two. See `relayTransport`.
 *
 * Whoever may frame this page may drive it, so the server that hosts relay.html
 * must restrict that with `Content-Security-Policy: frame-ancestors <host origins>`.
 */
import { ATTACH, REATTACH, RELAY_ATTACH, RELAY_READY, RELAY_REATTACH, RELAY_RELOAD, RELAY_SPAWN } from './protocol.js';
import { bridgeWorker, RELAY_PROCESS_WORKER } from './relayWorker.js';
import { broadcastReload, waitForActive } from './worker.js';

const host = window.parent;

async function start(): Promise<void> {
  const container = navigator.serviceWorker;
  if (!container) throw new Error('Service workers are unavailable on the preview origin.');
  const registration = await container.register(new URL('./sw.js', location.href).href, { scope: './' });
  await waitForActive(registration);

  container.addEventListener('message', (event) => {
    if (event.data?.type === REATTACH && typeof event.data.id === 'string') host.postMessage({ type: RELAY_REATTACH, id: event.data.id }, '*');
  });

  addEventListener('message', (event) => {
    if (event.source !== host) return;
    const data = event.data as { type?: string; id?: unknown; base?: unknown } | null;
    if (data?.type === RELAY_ATTACH && typeof data.id === 'string' && event.ports[0]) {
      registration.active?.postMessage({ type: ATTACH, id: data.id }, [event.ports[0]]);
    } else if (data?.type === RELAY_RELOAD && typeof data.base === 'string') {
      broadcastReload(data.base);
    } else if (data?.type === RELAY_SPAWN && event.ports[0]) {
      // Process code runs HERE, on the preview origin, never on the host's.
      bridgeWorker(event.ports[0], new Worker(new URL(`./${RELAY_PROCESS_WORKER}`, location.href), { name: 'bfwc-process' }));
    }
  });

  host.postMessage({ type: RELAY_READY }, '*');
}

start().catch((error: unknown) => {
  host.postMessage({ type: RELAY_READY, error: error instanceof Error ? error.message : String(error) }, '*');
});
