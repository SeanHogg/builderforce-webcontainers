import {
  ATTRIBUTION_OFF_MARKER,
  DevServer,
  attributionFromMarker,
  dirname,
  PortCookieJars,
  VirtualFileSystem,
  baseToProject,
  buildProject,
  projectToBase,
  runArguments,
  rootedFileSystem,
  exportZip,
  importZip,
  normalizePath,
  textResponse,
  PLATFORM_APPLICATION,
  WORKSPACE_APPLICATION,
  type PreviewUpdate,
  type ProcessOptions,
} from '@seanhogg/builderforce-webcontainers-core';
import { PREVIEW_ID, previewBase, randomNonce } from './protocol.js';
import { createProcessHost, databaseWorkerFactory, trackWorkers } from './node/index.js';
import { createPythonProcessKind } from './runtimes/python/pythonProcessKind.js';
import { createPhpProcessKind } from './runtimes/php/phpProcessKind.js';
import { createDotnetProcessKind } from './runtimes/dotnet/dotnetProcessKind.js';
import { createRustProcessKind } from './runtimes/rust/rustProcessKind.js';
import { listenToPreview } from './previewMessages.js';
import { listenToPreviewBridge } from './previewBridge.js';
import { openRelay, relayTransport, sameOriginTransport, type PreviewTransport } from './transport.js';
import { attachPreview } from './previewAttach.js';
import { checkPreviewOrigins, PreviewShieldError } from './previewOrigin.js';
import { createShieldTelemetry } from './security/shieldTelemetry.js';
import { applicationContext } from './security/securityEvent.js';
import { createPreviewOrigins } from './previewOrigins.js';
import { createEsbuildWasmBundler, createEsbuildWasmTransformer } from './esbuildWasm.js';
import { createCdnComponentCompilers } from './componentCompilers.js';
import { createCdnStyleCompilers } from './styleCompilers.js';
import { watchForPreviewUpdates } from './previewUpdates.js';
import type { PreviewRuntime, PreviewRuntimeOptions, SameOriginOptions } from './runtimeOptions.js';

export { toWire } from './previewAttach.js';
export type { CommonRuntimeOptions, PreviewRuntime, PreviewRuntimeOptions, RelayOptions, RuntimeBuildOptions, SameOriginOptions } from './runtimeOptions.js';

const DEFAULT_ROOT = '/home/project';

function randomId(): string {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 16) ?? Math.random().toString(36).slice(2, 18);
}

/**
 * Boot a preview runtime in this page: a virtual file system, a dev server over
 * it, and a service worker that routes the preview iframe's requests back here.
 *
 * Needs a secure context (https or localhost) for the service worker — and
 * nothing else: no cross-origin isolation headers, no SharedArrayBuffer. Pass
 * `relayUrl` to serve the preview from its own origin (see `RelayOptions`);
 * same-origin previews are refused unless `unprotectedSameOrigin` is set.
 */
export async function startPreviewRuntime(options: PreviewRuntimeOptions): Promise<PreviewRuntime> {
  const id = options.id ?? randomId();
  if (!PREVIEW_ID.test(id)) throw new Error(`Preview id "${id}" may only contain letters, digits, "_" and "-".`);

  // ONE telemetry per runtime: every page-side chokepoint reports to it; its sink is the embedder's.
  const telemetry = createShieldTelemetry({ sink: options.security?.sink });
  // W10 control 10: refused before anything boots when the preview would share this page's origin.
  checkPreviewOrigins(options, location.origin, telemetry);
  const transport = options.relayUrl
    ? await relayTransport(options.relayUrl)
    : await sameOriginTransport((options as SameOriginOptions).serviceWorkerUrl, options.scope);

  const base = previewBase(transport.scope, id);
  // Every bridge this runtime injects carries it; preview messages without it are refused.
  const nonce = randomNonce();
  const root = normalizePath(options.root ?? DEFAULT_ROOT);
  // Processes see the whole tree; everything else sees the project as `/`.
  const files = new VirtualFileSystem();
  const fs = rootedFileSystem(files, root);
  const components = options.components ?? createCdnComponentCompilers();
  const styles = options.styles ?? createCdnStyleCompilers();
  /** Run in every preview page: dev-server documents and pages virtual servers serve alike. */
  let previewScripts: string[] = [...(options.previewScripts ?? [])];
  let server: DevServer;
  try {
    const transformer = options.transformer ?? (await createEsbuildWasmTransformer());
    server = new DevServer({ fs, transformer, base, cdn: options.cdn, components, styles, attribution: attributionFromMarker(files, options.attribution), previewScripts, previewNonce: nonce, hot: options.hot });
  } catch (error) {
    transport.dispose();
    throw error;
  }

  const previewUrl = new URL(base, transport.origin).href;
  /** Attaches this runtime's previews to an application relay as it opens (control 1); set once the process host exists. */
  let attachTo: (relay: PreviewTransport, applicationId: string) => () => void = () => () => undefined;
  const origins = createPreviewOrigins({
    shared: transport,
    relayUrl: options.relayUrl,
    embeddingOrigin: location.origin,
    previewOrigin: options.previewOrigin,
    runtimeId: id,
    workerPolicy: options.workerPolicy,
    open: openRelay,
    onOpened: (relay, applicationId) => attachTo(relay, applicationId),
    telemetry,
  });
  // In relay mode processes run on the preview origin (the relay starts them; with `previewOrigin`, the application's own relay), never the host's.
  const node = { ...options.node, createWorker: options.node?.createWorker ?? origins.createWorker };
  // Python commands run in Python process Workers (Pyodide), PHP commands in PHP ones (php-wasm), .NET commands in .NET ones (Mono), beside the Node ones.
  const php = createPhpProcessKind(options.php, createPythonProcessKind(options.python));
  // Prebuilt wasm32-wasip1 modules (and the declined cargo/rustc) run in Rust process Workers.
  const kinds = createRustProcessKind(createDotnetProcessKind(options.dotnet, php));
  // Control 1: an application gets its own preview origin, or — only with the named opt-out — shares the relay's.
  const sharedAllowed = options.sharedPreviewOrigin === 'unprotected' || options.unprotectedSameOrigin === true;
  const refuseShared = (applicationId: string): string => {
    if (applicationId === WORKSPACE_APPLICATION || applicationId === PLATFORM_APPLICATION) return transport.origin;
    const refusal = new PreviewShieldError('ingress.preview_origin_invalid', `Application "${applicationId}" needs its own preview origin: set \`previewOrigin\`, or opt out by name with \`sharedPreviewOrigin: 'unprotected'\`.`);
    telemetry.report(refusal.reason, applicationContext(applicationId), { message: refusal.message });
    throw refusal;
  };
  const originOf = origins.enabled ? origins.originOf : sharedAllowed ? undefined : refuseShared;
  const processes = createProcessHost({ fs: files, cwd: root, base, origin: transport.origin, originOf, previewUrl, options: node, kinds, security: { telemetry } });
  // Databases never run where processes do in relay mode: their Workers start on this (host) origin.
  const databaseWorkers = trackWorkers(databaseWorkerFactory(options.node));

  const cookies = new PortCookieJars();
  /** Whether a request that came through `origin` may reach `port`: only through its owner's preview origin. */
  const admitPort = (origin: string, port: number) => {
    if (origins.mayServe(origin, processes.ports.ownerOf(port))) return true;
    // The asker is a preview document on `origin`: no process of ours, so unattributed; the port's owner is evidence.
    const owner = processes.ports.ownerOf(port);
    telemetry.report('ingress.app_origin_mismatch', undefined, { port, origin, ownerApplicationId: owner?.applicationId ?? null });
    return false;
  };
  const egressOf = (applicationId?: string) => (typeof options.previewEgress === 'function' ? options.previewEgress(applicationId) : options.previewEgress);
  const attachOn = (relay: PreviewTransport, applicationId?: string, devServer?: DevServer) =>
    attachPreview({ transport: relay, id, server: devServer, processes, cookies, scripts: () => previewScripts, bridgeNonce: nonce, egress: egressOf(applicationId), mayServePort: (port) => admitPort(relay.origin, port) });
  // The shared origin serves the dev server; an application's own origin only that application's ports.
  const stopAttach = attachOn(transport, undefined, server);
  attachTo = (relay, applicationId) => attachOn(relay, applicationId);

  // Every frame showing this preview hears what each burst of edits changed.
  const sendAll = (update: PreviewUpdate) => {
    for (const relay of origins.transports()) relay.send(base, update);
  };
  const reload = () => sendAll({ type: 'reload' });
  const stopWatching = options.liveReload === false ? undefined : watchForPreviewUpdates(fs, server, sendAll);

  const previewMessages = listenToPreview(window, origins.accepts, base, nonce);
  // WebSockets and document.cookie for virtual servers, which a service worker cannot carry.
  const bridge = listenToPreviewBridge(window, origins.accepts, base, { upgrade: (port, request) => processes.upgrade(port, request), cookies, nonce, admitPort });

  return {
    id,
    url: previewUrl,
    fs,
    root,
    server,
    phpPlatform: php.platform,
    writeTree: (files, at) => fs.writeTree(files, at),
    // With the project at `/`, the hidden badge marker's directory is inside it: never ship it in a download.
    exportZip: (zipOptions) =>
      exportZip(fs, root === '/' ? { ...zipOptions, exclude: [...(zipOptions?.exclude ?? []), dirname(ATTRIBUTION_OFF_MARKER).slice(1)] } : zipOptions),
    importZip: (zip, at, limits) => importZip(fs, zip, at, limits),
    reload,
    profile: () => server.profile(),
    async build(buildOptions = {}) {
      const bundler = options.bundler ?? (await createEsbuildWasmBundler());
      return buildProject({ files: fs, bundler, cdn: options.cdn, components, styles, base: buildOptions.base, minify: buildOptions.minify });
    },
    onError: (listener) => previewMessages.onError(listener),
    onPreviewConsole: (listener) => previewMessages.onConsole(listener),
    setPreviewScripts(scripts) {
      previewScripts = [...scripts];
      server.setPreviewScripts(previewScripts);
      reload();
    },
    run(command: string, argsOrOptions?: string[] | ProcessOptions, maybeOptions?: ProcessOptions) {
      const [args, runOptions] = runArguments(argsOrOptions, maybeOptions);
      return processes.run(command, args, runOptions.cwd === undefined ? runOptions : { ...runOptions, cwd: projectToBase(root, runOptions.cwd) });
    },
    onServerListening: (listener) => processes.servers.onListening(listener),
    onPortChange: (listener) => processes.servers.onPortChange(listener),
    listProcesses: () => processes.list().map((info) => ({ ...info, cwd: baseToProject(root, info.cwd) ?? info.cwd })),
    request: (port, request, caller) => processes.request(port, { method: 'GET', headers: {}, body: null, ...request }, caller),
    listenTcp: (port, accept, owner) => processes.ports.listen(port, async () => textResponse(502, 'Not an HTTP server'), undefined, accept, owner),
    connect: (port, caller) => processes.ports.connect(port, caller),
    portPolicy: processes.portPolicy,
    killApplication(applicationId, serviceId) {
      processes.killApplication(applicationId, serviceId);
      if (serviceId === undefined) origins.release(applicationId); // its relay closes; its origin stays its own
    },
    createDatabaseWorker: () => databaseWorkers.create(),
    security: () => telemetry,
    cookies,
    dispose() {
      bridge.dispose();
      stopAttach();
      processes.dispose();
      origins.dispose();
      databaseWorkers.terminateAll();
      previewMessages.dispose();
      stopWatching?.();
      transport.dispose();
      server.dispose();
    },
  };
}
