import {
  DevServer,
  ERROR_MESSAGE_TYPE,
  VirtualFileSystem,
  type DevServerOptions,
  type FileSystemTree,
  type FlatFiles,
  type ProjectProfile,
  type Transformer,
} from '@seanhogg/builderforce-webcontainers-core';
import { ATTACH, REATTACH, isWireRequest, previewBase, type WireResponse } from './protocol.js';
import { createEsbuildWasmTransformer } from './esbuildWasm.js';

export interface BootOptions {
  /** Where the host serves this package's `dist/sw.js` (e.g. `/__bfwc/sw.js`). */
  serviceWorkerUrl: string;
  /** Worker scope. Defaults to the worker script's directory. */
  scope?: string;
  /** Compiler. Defaults to esbuild-wasm. */
  transformer?: Transformer;
  /** Package CDN factory. Defaults to esm.sh. */
  cdn?: DevServerOptions['cdn'];
  /** Stable id (e.g. the project id) — keeps the preview URL stable across reloads. */
  id?: string;
  /** The "Built with Builderforce.ai" badge in the preview. Default true — please keep it. */
  attribution?: boolean;
}

export interface PreviewError {
  message: string;
  stack?: string;
  href: string;
}

export interface PreviewRuntime {
  readonly id: string;
  /** Absolute URL to load in the preview iframe. */
  readonly url: string;
  readonly fs: VirtualFileSystem;
  readonly server: DevServer;
  mount(files: FileSystemTree | FlatFiles): void;
  /** Whether this runtime can serve the mounted project, and why not. */
  profile(): ProjectProfile;
  /** Uncaught errors and rejections raised inside the preview. */
  onError(listener: (error: PreviewError) => void): () => void;
  dispose(): void;
}

function waitForActive(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
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

function randomId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Math.random().toString(36).slice(2, 18);
}

function toWire(reqId: number, served: Awaited<ReturnType<DevServer['handle']>>): { message: WireResponse; transfer: Transferable[] } {
  if (typeof served.body === 'string') {
    return { message: { type: 'response', reqId, status: served.status, headers: served.headers, body: served.body }, transfer: [] };
  }
  const body = served.body.slice().buffer as ArrayBuffer; // a copy: transferring must not detach the VFS's own bytes
  return { message: { type: 'response', reqId, status: served.status, headers: served.headers, body }, transfer: [body] };
}

/**
 * Boot a preview runtime in this page: a virtual file system, a dev server over
 * it, and a service worker that routes the preview iframe's requests back here.
 *
 * Needs a secure context (https or localhost) for the service worker — and
 * nothing else: no cross-origin isolation headers, no SharedArrayBuffer.
 */
export async function bootPreviewRuntime(options: BootOptions): Promise<PreviewRuntime> {
  const container = navigator.serviceWorker;
  if (!container) throw new Error('Service workers are unavailable here (a secure context — https or localhost — is required).');

  const scriptUrl = new URL(options.serviceWorkerUrl, location.href);
  const scope = new URL(options.scope ?? './', scriptUrl).pathname;
  const registration = await container.register(scriptUrl.href, { scope });
  await waitForActive(registration);

  const id = options.id ?? randomId();
  const base = previewBase(scope, id);
  const fs = new VirtualFileSystem();
  const transformer = options.transformer ?? (await createEsbuildWasmTransformer());
  const server = new DevServer({ fs, transformer, base, cdn: options.cdn, attribution: options.attribution });

  const attach = (worker: ServiceWorker) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = async (event) => {
      if (!isWireRequest(event.data)) return;
      const { message, transfer } = toWire(event.data.reqId, await server.handle(event.data.path, event.data.search));
      channel.port1.postMessage(message, transfer);
    };
    worker.postMessage({ type: ATTACH, id }, [channel.port2]);
  };
  attach(registration.active!);

  const onWorkerMessage = (event: MessageEvent) => {
    if (event.data?.type === REATTACH && event.data.id === id && registration.active) attach(registration.active);
  };
  container.addEventListener('message', onWorkerMessage);

  const errorListeners = new Set<(error: PreviewError) => void>();
  const onWindowMessage = (event: MessageEvent) => {
    const data = event.data as Partial<PreviewError> & { type?: string };
    if (data?.type !== ERROR_MESSAGE_TYPE || typeof data.href !== 'string') return;
    if (!new URL(data.href).pathname.startsWith(base)) return; // another runtime's preview
    const error: PreviewError = { message: String(data.message ?? ''), stack: data.stack, href: data.href };
    for (const listener of errorListeners) listener(error);
  };
  window.addEventListener('message', onWindowMessage);

  return {
    id,
    url: new URL(base, location.origin).href,
    fs,
    server,
    mount: (files) => fs.mount(files),
    profile: () => server.profile(),
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    dispose() {
      container.removeEventListener('message', onWorkerMessage);
      window.removeEventListener('message', onWindowMessage);
      errorListeners.clear();
      server.dispose();
    },
  };
}
