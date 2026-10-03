import {
  DevServer,
  ERROR_MESSAGE_TYPE,
  VirtualFileSystem,
  buildProject,
  type BuildResult,
  type Bundler,
  type ComponentCompilers,
  type FileSystemTree,
  type FlatFiles,
  type PackageCdnFactory,
  type ProjectProfile,
  type Transformer,
} from '@seanhogg/builderforce-webcontainers-core';
import { PREVIEW_ID, isWireRequest, previewBase, type WireResponse } from './protocol.js';
import { relayTransport, sameOriginTransport } from './transport.js';
import { createEsbuildWasmBundler, createEsbuildWasmTransformer } from './esbuildWasm.js';
import { createCdnComponentCompilers } from './componentCompilers.js';

/** Serve previews on THIS page's origin. Only for code the page's own user trusts. */
export interface SameOriginOptions {
  /** Where the host serves this package's `dist/sw.js` (e.g. `/__bfwc/sw.js`). */
  serviceWorkerUrl: string;
  /** Worker scope. Defaults to the worker script's directory. */
  scope?: string;
  relayUrl?: never;
}

/**
 * Serve previews on a SEPARATE origin, isolated from this page's cookies, storage
 * and DOM. That origin serves `dist/relay.html` and `dist/sw.js` side by side, with
 * `frame-ancestors` limited to the pages allowed to drive it.
 */
export interface RelayOptions {
  /** e.g. `https://preview.example.com/__bfwc/relay.html`. */
  relayUrl: string;
  serviceWorkerUrl?: never;
  scope?: never;
}

export type BootOptions = (SameOriginOptions | RelayOptions) & CommonBootOptions;

export interface CommonBootOptions {
  /** Compiler. Defaults to esbuild-wasm. */
  transformer?: Transformer;
  /** Package CDN factory, for previews (`dev: true`) and builds (`dev: false`). Defaults to esm.sh. */
  cdn?: PackageCdnFactory;
  /** `.vue` / `.svelte` compilers. Default: the official ones, fetched from a CDN on first use. */
  components?: ComponentCompilers;
  /** Bundler for `build()`. Default: esbuild-wasm (the same instance as the compiler). */
  bundler?: Bundler;
  /** Stable id (e.g. the project id; `[A-Za-z0-9_-]`) — keeps the preview URL stable across reloads. */
  id?: string;
  /** The "Built with Builderforce.ai" badge in the preview. Default true — please keep it. */
  attribution?: boolean;
  /** Reload open previews when files change. Default true. */
  liveReload?: boolean;
}

/** Edits arrive in bursts (a save, an agent writing several files): reload once per burst. */
const RELOAD_DEBOUNCE_MS = 120;

export interface PreviewError {
  message: string;
  stack?: string;
  href: string;
}

export interface RuntimeBuildOptions {
  /** Where the site will be served from. Default `./` (works from any directory). */
  base?: string;
  /** Default true. */
  minify?: boolean;
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
  /**
   * `npm run build` for the mounted files: a deployable static site (index.html,
   * hashed `assets/`, `public/` copied). Rejects with the reason when the project
   * is not one this runtime supports, or with the bundler's errors.
   */
  build(options?: RuntimeBuildOptions): Promise<BuildResult>;
  /** Uncaught errors and rejections raised inside the preview. */
  onError(listener: (error: PreviewError) => void): () => void;
  dispose(): void;
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
 * nothing else: no cross-origin isolation headers, no SharedArrayBuffer. Pass
 * `relayUrl` to serve the preview from its own origin (see `RelayOptions`).
 */
export async function bootPreviewRuntime(options: BootOptions): Promise<PreviewRuntime> {
  const id = options.id ?? randomId();
  if (!PREVIEW_ID.test(id)) throw new Error(`Preview id "${id}" may only contain letters, digits, "_" and "-".`);

  const transport = options.relayUrl
    ? await relayTransport(options.relayUrl)
    : await sameOriginTransport((options as SameOriginOptions).serviceWorkerUrl, options.scope);

  const base = previewBase(transport.scope, id);
  const fs = new VirtualFileSystem();
  const components = options.components ?? createCdnComponentCompilers();
  let server: DevServer;
  try {
    const transformer = options.transformer ?? (await createEsbuildWasmTransformer());
    server = new DevServer({ fs, transformer, base, cdn: options.cdn, components, attribution: options.attribution });
  } catch (error) {
    transport.dispose();
    throw error;
  }

  const attach = () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = async (event) => {
      if (!isWireRequest(event.data)) return;
      const { message, transfer } = toWire(event.data.reqId, await server.handle(event.data.path, event.data.search));
      channel.port1.postMessage(message, transfer);
    };
    transport.attach(id, channel.port2);
  };
  attach();
  const stopReattach = transport.onReattach((wanted) => {
    if (wanted === id) attach();
  });

  // Live reload: any change to the files reloads every frame showing this preview.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const stopWatching = options.liveReload === false
    ? undefined
    : fs.watch(() => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => transport.reload(base), RELOAD_DEBOUNCE_MS);
    });

  const errorListeners = new Set<(error: PreviewError) => void>();
  const onWindowMessage = (event: MessageEvent) => {
    const data = event.data as Partial<PreviewError> & { type?: string };
    if (data?.type !== ERROR_MESSAGE_TYPE || typeof data.href !== 'string') return;
    if (event.origin !== transport.origin || !new URL(data.href).pathname.startsWith(base)) return; // another runtime's preview
    const error: PreviewError = { message: String(data.message ?? ''), stack: data.stack, href: data.href };
    for (const listener of errorListeners) listener(error);
  };
  window.addEventListener('message', onWindowMessage);

  return {
    id,
    url: new URL(base, transport.origin).href,
    fs,
    server,
    mount: (files) => fs.mount(files),
    profile: () => server.profile(),
    async build(buildOptions = {}) {
      const bundler = options.bundler ?? (await createEsbuildWasmBundler());
      return buildProject({ files: fs, bundler, cdn: options.cdn, components, base: buildOptions.base, minify: buildOptions.minify });
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    dispose() {
      window.removeEventListener('message', onWindowMessage);
      errorListeners.clear();
      clearTimeout(reloadTimer);
      stopWatching?.();
      stopReattach();
      transport.dispose();
      server.dispose();
    },
  };
}
