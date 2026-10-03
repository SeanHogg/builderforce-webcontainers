/**
 * Small helpers shared by the page-side transports and the relay page.
 */
import { reloadChannelName } from '@seanhogg/builderforce-webcontainers-core';

/** Resolve once the registration has an active worker. */
export function waitForActive(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (registration.active) return Promise.resolve(registration.active);
  const installing = registration.installing ?? registration.waiting;
  if (!installing) return Promise.reject(new Error('The preview service worker did not install.'));
  return new Promise((resolve, reject) => {
    installing.addEventListener('statechange', () => {
      if (installing.state === 'activated' && registration.active) resolve(registration.active);
      if (installing.state === 'redundant') reject(new Error('The preview service worker failed to install.'));
    });
  });
}

/** Reload every frame (on this origin) showing the preview served at `base`. */
export function broadcastReload(base: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(reloadChannelName(base));
  channel.postMessage('reload');
  channel.close();
}
