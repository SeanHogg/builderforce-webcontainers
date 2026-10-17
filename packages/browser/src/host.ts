import {
  DevServer,
  VirtualFileSystem,
  buildProject,
  exportZip,
  importZip,
  type BuildResult,
  type Bundler,
  type ComponentCompilers,
  type FileTree,
  type PackageCdnFactory,
  type PortChange,
  type ProcessOptions,
  type ProjectProfile,
  type RuntimeProcess,
  type ServerAddress,
  type Transformer,
  type ZipExportOptions,
} from '@seanhogg/builderforce-webcontainers-core';
import { PREVIEW_ID, isPortPath, isWireRequest, previewBase, type WireRequest, type WireResponse } from './protocol.js';
import { createProcessHost, servePortRequest, type NodeRuntimeOptions, type ProcessInfo } from './node/index.js';
import { listenToPreview, type PreviewConsoleMessage, type PreviewError } from './previewMessages.js';
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

export type PreviewRuntimeOptions = (SameOriginOptions | RelayOptions) & CommonRuntimeOptions;

export interface CommonRuntimeOptions {
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
  /** Your scripts (JavaScript source), run in every preview page before the app — analytics, test hooks, a mock `fetch`. */
  previewScripts?: string[];
  /** The Node runtime behind `run` (process workers, npm registry). */
  node?: NodeRuntimeOptions;
}

/** Edits arrive in bursts (a save, an agent writing several files): reload once per burst. */
const RELOAD_DEBOUNCE_MS = 120;

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
  /** Write files into the runtime (nested or flat; see `FileTree`), under `at` (default `/`). Open previews reload. */
  writeTree(files: FileTree, at?: string): void;
  /** The project as a zip — "Download project" with `exclude: ['node_modules']`, or a full snapshot to restore later. */
  exportZip(options?: ZipExportOptions): Uint8Array;
  /** Write a zip's contents (an `exportZip` snapshot, a downloaded template) into the runtime, under `at`. */
  importZip(zip: Uint8Array, at?: string): void;
  /** Reload every frame showing this preview now (live reload does this on edits by itself). */
  reload(): void;
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
  /** The preview's `console.log/info/warn/error/debug` output (first 1,000 messages per page load). */
  onPreviewConsole(listener: (message: PreviewConsoleMessage) => void): () => void;
  /** Replace the scripts run in preview pages; open previews reload to pick them up. */
  setPreviewScripts(scripts: string[]): void;
  /**
   * Run a command — `node server.js`, `npm install`, `npm run dev`, `bfsh` for a
   * terminal — in its own Web Worker. Pass `{ terminal: { cols, rows } }` when
   * wiring it to xterm.js.
   */
  run(command: string, args?: string[], options?: ProcessOptions): RuntimeProcess;
  run(command: string, options?: ProcessOptions): RuntimeProcess;
  /** A process started listening (or a dev script handed off to the preview); `url` loads it in an iframe. */
  onServerListening(listener: (server: ServerAddress) => void): () => void;
  /** A virtual server opened or closed its port. */
  onPortChange(listener: (change: PortChange) => void): () => void;
  /** Processes still running, with the ports their servers listen on. */
  listProcesses(): ProcessInfo[];
  dispose(): void;
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Math.random().toString(36).slice(2, 18);
}

export function toWire(reqId: number, served: Awaited<ReturnType<DevServer['handle']>>): { message: WireResponse; transfer: Transferable[] } {
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
export async function startPreviewRuntime(options: PreviewRuntimeOptions): Promise<PreviewRuntime> {
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
    server = new DevServer({ fs, transformer, base, cdn: options.cdn, components, attribution: options.attribution, previewScripts: options.previewScripts });
  } catch (error) {
    transport.dispose();
    throw error;
  }

  const previewUrl = new URL(base, transport.origin).href;
  // In relay mode processes run on the preview origin (the relay starts them), never the host's.
  const node = { ...options.node, createWorker: options.node?.createWorker ?? transport.createWorker?.bind(transport) };
  const processes = createProcessHost({ fs, base, origin: transport.origin, previewUrl, options: node });

  const answer = async (request: WireRequest) =>
    isPortPath(request.path) ? servePortRequest(processes, request) : toWire(request.reqId, await server.handle(request.path, request.search));

  const attach = () => {
    const channel = new MessageChannel();
    channel.port1.onmessage = async (event) => {
      if (!isWireRequest(event.data)) return;
      const { message, transfer } = await answer(event.data);
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

  const previewMessages = listenToPreview(window, transport.origin, base);

  return {
    id,
    url: previewUrl,
    fs,
    server,
    writeTree: (files, at) => fs.writeTree(files, at),
    exportZip: (zipOptions) => exportZip(fs, zipOptions),
    importZip: (zip, at) => importZip(fs, zip, at),
    reload: () => transport.reload(base),
    profile: () => server.profile(),
    async build(buildOptions = {}) {
      const bundler = options.bundler ?? (await createEsbuildWasmBundler());
      return buildProject({ files: fs, bundler, cdn: options.cdn, components, base: buildOptions.base, minify: buildOptions.minify });
    },
    onError: (listener) => previewMessages.onError(listener),
    onPreviewConsole: (listener) => previewMessages.onConsole(listener),
    setPreviewScripts(scripts) {
      server.setPreviewScripts(scripts);
      transport.reload(base);
    },
    run: (command: string, args?: string[] | ProcessOptions, runOptions?: ProcessOptions) => processes.run(command, args as string[], runOptions),
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list(),
    dispose() {
      processes.dispose();
      previewMessages.dispose();
      clearTimeout(reloadTimer);
      stopWatching?.();
      stopReattach();
      transport.dispose();
      server.dispose();
    },
  };
}
