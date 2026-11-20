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
  isApplicationId,
  normalizePath,
  textResponse,
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
import { checkPreviewOrigins } from './previewOrigin.js';
import { relayConfigUrl } from './relayConfig.js';
import { createShieldTelemetry } from './security/shieldTelemetry.js';
import { createPreviewOrigins } from './previewOrigins.js';
import { createPreviewIngress } from './previewIngress.js';
import { createEsbuildWasmBundler, createEsbuildWasmTransformer } from './esbuildWasm.js';
import { createCdnComponentCompilers } from './componentCompilers.js';
import { createCdnStyleCompilers } from './styleCompilers.js';
import { watchForPreviewUpdates } from './previewUpdates.js';
import type { PreviewRuntime, PreviewRuntimeOptions, SameOriginOptions } from './runtimeOptions.js';

export { toWire } from './previewAttach.js';
export type { CommonRuntimeOptions, PreviewRuntime, PreviewRuntimeOptions, RelayOptions, RuntimeBuildOptions, SameOriginOptions } from './runtimeOptions.js';

const DEFAULT_ROOT = '/home/project';

/** The default package CDN (`cdn` unset): previews load packages from it, so it is always in their egress. */
const DEFAULT_CDN_ORIGIN = 'https://esm.sh';

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
  /** The egress a preview origin's responses may reach (host-side; never from an attach): the embedder's, plus the default package CDN previews load from. */
  const previewEgress = (applicationId?: string): readonly string[] => {
    const declared = typeof options.previewEgress === 'function' ? options.previewEgress(applicationId) : (options.previewEgress ?? []);
    return options.cdn ? declared : [DEFAULT_CDN_ORIGIN, ...declared];
  };
  // The shared origin's worker takes its egress and report endpoint from its own URL (`relayConfig`).
  const sharedConfig = { egress: previewEgress(undefined), report: options.cspReportUrl };
  const transport = options.relayUrl
    ? await relayTransport(relayConfigUrl(options.relayUrl, sharedConfig, location.href))
    : await sameOriginTransport(relayConfigUrl((options as SameOriginOptions).serviceWorkerUrl, sharedConfig, location.href), options.scope);

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
    sharedPreviewOrigin: options.sharedPreviewOrigin ?? (options.unprotectedSameOrigin ? 'unprotected' : undefined),
    previewEgress,
    cspReportUrl: options.cspReportUrl,
    runtimeId: id,
    workerPolicy: options.workerPolicy,
    createWorker: options.node?.createWorker,
    open: openRelay,
    onOpened: (relay, applicationId) => attachTo(relay, applicationId),
    telemetry,
  });
  // In relay mode processes run on the preview origin (the relay starts them; with `previewOrigin`, the application's own relay), never the host's;
  // a custom `node.createWorker` is handed each application's origin and policy (`WorkerTarget`).
  const node = { ...options.node, createWorker: origins.createWorker };
  // Python commands run in Python process Workers (Pyodide), PHP commands in PHP ones (php-wasm), .NET commands in .NET ones (Mono), beside the Node ones.
  // Memory cannot be shared with a Worker behind a relay or on another origin: training's shared checkpoint flag is off there
  // (a SharedArrayBuffer in the start message could not cross). A custom `node.createWorker` is the embedder's to judge (`sharedFlags`).
  const relayed = !!options.relayUrl || origins.enabled;
  const pythonOptions = options.python?.training && relayed ? { ...options.python, training: { ...options.python.training, sharedFlags: false } } : options.python;
  const python = createPythonProcessKind(pythonOptions);
  const php = createPhpProcessKind(options.php, python);
  // Prebuilt wasm32-wasip1 modules (and the declined cargo/rustc) run in Rust process Workers.
  const kinds = createRustProcessKind(createDotnetProcessKind(options.dotnet, php));
  // Control 1: an application gets its own preview origin, or — only with the named opt-out — shares the relay's (`origins.originOf` refuses or announces it, before the process exists).
  const processes = createProcessHost({ fs: files, cwd: root, base, origin: transport.origin, originOf: origins.originOf, previewUrl, options: node, kinds, security: { telemetry } });
  // Training checkpoints and save acknowledgements reach a process through the host.
  python.training?.connect((pid, message) => processes.notify(pid, message));
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
  /** The application whose attributed process announced the live dev-server handoff: the shared dev server serves its frontend. */
  const handoffApplication = () => {
    const applicationId = processes.handoffs.current()?.context?.applicationId;
    return applicationId !== undefined && isApplicationId(applicationId) ? applicationId : undefined;
  };
  // Applications' ingress tables (registered from their specs by `startApplicationRuntime`), per preview origin.
  const ingress = createPreviewIngress({
    ownerOf: (port) => processes.ports.ownerOf(port),
    handoffApplication,
    onSharedOrigin: (applicationId) => origins.mayServe(transport.origin, { applicationId, serviceId: '' }),
  });
  const attachOn = (relay: PreviewTransport, devServer?: DevServer, applicationId?: string) =>
    attachPreview({
      transport: relay,
      id,
      server: devServer,
      processes,
      cookies,
      scripts: () => previewScripts,
      bridgeNonce: nonce,
      mayServePort: (port) => admitPort(relay.origin, port),
      ingress: ingress.view(applicationId),
    });
  // The shared origin serves the dev server; an application's own origin only that application's ports.
  const stopAttach = attachOn(transport, server);
  attachTo = (relay, applicationId) => attachOn(relay, undefined, applicationId);

  // Every frame showing this preview hears what each burst of edits changed.
  const sendAll = (update: PreviewUpdate) => {
    for (const relay of origins.transports()) relay.send(base, update);
  };
  const reload = () => sendAll({ type: 'reload' });

  // A dev-server handoff (`vite`, `ng serve`) serves its own directory — a frontend in `/web` beside an `/api` —
  // at the preview URL, for as long as the process that announced it lives (or until it is interrupted); then the
  // handoff before it is in force again, else the whole project. Confined to the project: a directory outside it
  // serves the project as without a handoff, so a handoff only ever narrows what is served. Open previews reload.
  const stopRoots = processes.handoffs.onChange(() => {
    const directory = processes.handoffs.current()?.root;
    const served = (directory === undefined ? undefined : baseToProject(root, directory)) ?? '/';
    if (served !== server.servedRoot) {
      server.setRoot(served);
      reload();
    }
    ingress.refresh(); // the shared origin's table follows the live handoff's application
  });
  const stopWatching = options.liveReload === false ? undefined : watchForPreviewUpdates(fs, server, sendAll);

  const previewMessages = listenToPreview(window, origins.accepts, base, nonce);
  // WebSockets and document.cookie for virtual servers, which a service worker cannot carry.
  const bridge = listenToPreviewBridge(window, origins.accepts, base, { upgrade: (port, request) => processes.upgrade(port, request), cookies, nonce, admitPort, telemetry });

  return {
    id,
    url: previewUrl,
    fs,
    root,
    server,
    phpPlatform: php.platform,
    pythonTraining: python.training,
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
    registerIngress: (applicationId, spec) => ingress.register(applicationId, spec),
    killApplication(applicationId, serviceId) {
      processes.killApplication(applicationId, serviceId);
      if (serviceId === undefined) origins.release(applicationId); // its relay closes; its origin stays its own
    },
    forgetApplication: (applicationId) => python.forgetApplication(applicationId),
    createDatabaseWorker: () => databaseWorkers.create(),
    security: () => telemetry,
    cookies,
    dispose() {
      stopRoots();
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
