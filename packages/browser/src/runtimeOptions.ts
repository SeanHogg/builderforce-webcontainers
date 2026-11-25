/**
 * What `startPreviewRuntime` takes and returns (split from host.ts, which boots it).
 */
import type {
  BuildResult,
  Bundler,
  ByteChannel,
  ComponentCompilers,
  ConnectionHandler,
  DevServer,
  FileTree,
  HttpRequestData,
  HttpResponseData,
  PackageCdnFactory,
  PortChange,
  PortCookieJars,
  ProcessOptions,
  ProjectProfile,
  RuntimeProcess,
  SecurityContext,
  ServerAddress,
  StyleCompilers,
  Transformer,
  VirtualFileSystem,
  ZipExportOptions,
  ZipImportLimits,
} from '@seanhogg/builderforce-webcontainers-core';
import type { ApplicationSpec, ServiceGraphPolicy } from '@seanhogg/builderforce-webcontainers-core/app';
import type { NodeRuntimeOptions, ProcessInfo } from './node/index.js';
import type { WorkerLike } from './node/processHost.js';
import type { PythonHostOptions } from './runtimes/python/pythonProcessKind.js';
import type { TrainingServices } from './runtimes/python/trainingChannel.js';
import type { PhpHostOptions, PhpPlatformRecord } from './runtimes/php/phpProcessKind.js';
import type { DotnetHostOptions } from './runtimes/dotnet/dotnetProcessKind.js';
import type { PreviewConsoleMessage, PreviewCspViolation, PreviewError } from './previewMessages.js';
import type { PreviewCspMode } from './relayConfig.js';
import type { RuntimeDiagnostics } from './diagnostics.js';
import type { PreviewOriginOption } from './previewOrigin.js';
import type { SecurityEventSink } from './security/securityEvent.js';
import type { ShieldTelemetry } from './security/shieldTelemetry.js';

/**
 * Serve previews on THIS page's origin. Only for code the page's own user trusts:
 * the Security Shield refuses it (`PreviewShieldError`, `ingress.same_origin_refused`)
 * unless `unprotectedSameOrigin` says, by name, that previews may read this page's
 * cookies, storage and DOM.
 */
export interface SameOriginOptions {
  /** Where the host serves this package's `dist/sw.js` (e.g. `/__bfwc/sw.js`). */
  serviceWorkerUrl: string;
  /** Worker scope. Defaults to the worker script's directory. */
  scope?: string;
  /** Required for this mode: previews and processes share this page's origin, unprotected. Never set it for AI-written or third-party code. */
  unprotectedSameOrigin: true;
  relayUrl?: never;
  previewOrigin?: never;
  workerPolicy?: never;
  /** Same-origin mode shares everything already (`unprotectedSameOrigin`). */
  sharedPreviewOrigin?: never;
}

/**
 * Serve previews on a SEPARATE origin, isolated from this page's cookies, storage
 * and DOM. That origin serves `dist/relay.html` and `dist/sw.js` side by side, with
 * `frame-ancestors` limited to the pages allowed to drive it.
 */
export interface RelayOptions {
  /** e.g. `https://preview.example.com/__bfwc/relay.html`. Its origin must differ from this page's. */
  relayUrl: string;
  /**
   * Each application's own preview origin (W10 control 1), e.g.
   * `previewOriginTemplate('https://{key}.preview.example.com')`, where the key
   * is a hash of (this runtime's `id`, the application's stable id) — pass the
   * project id as `id` so keys are unique across projects and the same on every
   * start: a bare https origin, distinct from this page's, from `relayUrl`'s and
   * from every other application's — else the application's first process is
   * refused (`ingress.preview_origin_invalid`). That origin must serve the relay
   * files at `relayUrl`'s path (README › Preview origin headers). REQUIRED for
   * applications: unset, an application's first process is refused
   * (`PreviewShieldError`, `ingress.app_origin_required`) unless
   * `sharedPreviewOrigin: 'unprotected'` opts out. The workspace and the instant
   * preview need none.
   */
  previewOrigin?: PreviewOriginOption;
  /**
   * The named opt-out from control 1: without `previewOrigin`, an application's
   * first process is refused (`PreviewShieldError`) unless this says, by name,
   * that applications may share `relayUrl`'s origin (storage, Cache Storage,
   * BroadcastChannels, service worker) with each other. Never a default.
   */
  sharedPreviewOrigin?: 'unprotected';
  /**
   * The egress policy id (opaque, signed by you; `[A-Za-z0-9._~-]`, at most 512)
   * the relay puts on each application's process Worker script URL as
   * `?policy=<id>`, so your server serves that policy's CSP. A function answers
   * per application (the same every time). Workspace processes and spares made
   * before an application is known carry none: serve them the most restrictive policy.
   */
  workerPolicy?: string | ((applicationId: string) => string | undefined);
  serviceWorkerUrl?: never;
  scope?: never;
  unprotectedSameOrigin?: never;
}

export type PreviewRuntimeOptions = (SameOriginOptions | RelayOptions) & CommonRuntimeOptions;

export interface CommonRuntimeOptions {
  /** Compiler. Defaults to esbuild-wasm. */
  transformer?: Transformer;
  /** Package CDN factory, for previews (`dev: true`) and builds (`dev: false`). Defaults to esm.sh. Its `origins` join every preview's egress (see `previewEgress`). */
  cdn?: PackageCdnFactory;
  /** `.vue` / `.svelte` compilers. Default: the official ones, fetched from a CDN on first use. */
  components?: ComponentCompilers;
  /** Sass / Less compilers. Default: the official pure-JS builds, fetched from a CDN on first use. */
  styles?: StyleCompilers;
  /** Bundler for `build()`. Default: esbuild-wasm (the same instance as the compiler). */
  bundler?: Bundler;
  /**
   * The project's directory, as Node programs see it: where `run` starts and
   * `process.cwd()` points. Everything this runtime hands you (`fs`,
   * `writeTree`, zips, the dev server, `build`) addresses the project as `/`.
   * Default `/home/project`; `/` puts the project at the file-system root,
   * which file watchers (chokidar under Vite, so SvelteKit) mishandle.
   */
  root?: string;
  /** Stable id (e.g. the project id; `[A-Za-z0-9_-]`) — keeps the preview URL stable across reloads. */
  id?: string;
  /** The "Built with Builderforce.ai" badge in the preview. Default true — please keep it. */
  attribution?: boolean;
  /** Update open previews when files change. Default true. */
  liveReload?: boolean;
  /**
   * Apply edits in place where possible: stylesheets swap and React components
   * re-render keeping their state (Fast Refresh); anything else reloads. `false`
   * reloads on every edit. Default true.
   */
  hot?: boolean;
  /** A project-relative HTML file (`/mockup.html`) served at `/` instead of `index.html`: a page run on its own with the files beside it. */
  page?: string;
  /** Your scripts (JavaScript source), run in every preview page before the app — analytics, test hooks, a mock `fetch`. */
  previewScripts?: string[];
  /** The Node runtime behind `run` (process workers, npm registry). */
  node?: NodeRuntimeOptions;
  /** Python processes (`python`, `pip`, `uvicorn` …): where Pyodide is served, host extensions. */
  python?: PythonHostOptions;
  /** PHP processes (`php`, `php -S`, `composer`): where php-wasm is served, the PHP version, Composer's sources. */
  php?: PhpHostOptions;
  /**
   * .NET processes (`dotnet run`, `dotnet build`, `./app.cs`): where the runtime
   * bundle is served (`bundleUrl`). Normally you serve the bundle each release
   * publishes as the npm package `@seanhogg/builderforce-webcontainers-dotnet`
   * (`DOTNET_BUNDLE.npmPackage`), at this package's exact version; building it
   * from source with scripts/build-dotnet-runtime.mjs is the alternative. The
   * runtime fetches nothing by itself: without `bundleUrl`, `dotnet` commands
   * decline with the reason.
   */
  dotnet?: DotnetHostOptions;
  /**
   * The Security Shield's telemetry: where its events (`SecurityEvent`, from
   * `@seanhogg/builderforce-webcontainers/security`) leave the runtime. Reason
   * codes and redacted evidence only; a throwing sink is ignored.
   */
  security?: { sink?: SecurityEventSink };
  /**
   * Where browsers send CSP violation reports for preview responses
   * (`report-to bfwc-csp`, with `Reporting-Endpoints`): an absolute https URL on
   * your API. It reaches each origin's service worker in its own script URL,
   * never by message. Reports are never trusted from inside a Worker.
   */
  cspReportUrl?: string;
  /**
   * External sources preview responses may reach (`https://api.example.com`,
   * `https://*.example.com`, `wss://…`; no paths). The preview CSP's egress is
   * exactly: the preview's own origin, plus the package CDN's origins (`cdn`'s
   * `origins`; `cdn` unset: `https://esm.sh`), plus this list. It never replaces
   * the CDN's origins; a custom `cdn` without `origins` contributes none (the
   * runtime warns once) — declare them on the factory or list them here. The
   * service worker stamps the result into every response it serves, beside any
   * CSP the app sets. Host-side only: each origin's service worker takes it from
   * its own script URL, never from an attach. A function answers per application
   * (undefined: the workspace's previews). Default: none.
   */
  previewEgress?: readonly string[] | ((applicationId: string | undefined) => readonly string[]);
  /**
   * `'report-only'` stamps the runtime's preview CSP as
   * `Content-Security-Policy-Report-Only`: violations are reported
   * (`cspReportUrl`, `onCspViolation`) but nothing is blocked. For migrating an
   * app to the policy only — it turns the WHOLE runtime policy report-only, not
   * just egress: `frame-src`, `worker-src`, `form-action` and every other
   * directive stop being enforced too. Travels to each origin's service worker in
   * its script URL (`csp=report-only`), like `previewEgress`, so the embedder's
   * `sw.js` gate must deliberately allow `csp` (README › Preview origin headers);
   * the launcher's and the Builderforce API's gates refuse it. Default `'enforce'`.
   */
  previewCspMode?: PreviewCspMode;
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
  /** The project, rooted at `/` (see `root`). */
  readonly fs: VirtualFileSystem;
  /** The project's directory as Node programs see it (`/home/project` by default). */
  readonly root: string;
  readonly server: DevServer;
  /** The PHP that PHP processes reported running (`createPhpProvider(runtime, { platform: runtime.phpPlatform, php })`). */
  readonly phpPlatform: PhpPlatformRecord;
  /** Training services' page side, when `python.training` is set (`createPythonProvider(runtime, { training: runtime.pythonTraining })`); without it the Python provider declines training services. */
  readonly pythonTraining?: TrainingServices;
  /** Write files into the runtime (nested or flat; see `FileTree`), under `at` (default `/`). Open previews update. */
  writeTree(files: FileTree, at?: string): void;
  /** The project as a zip — "Download project" with `exclude: ['node_modules']`, or a full snapshot to restore later. */
  exportZip(options?: ZipExportOptions): Uint8Array;
  /** Write a zip's contents (an `exportZip` snapshot, a downloaded template) into the runtime, under `at`. Throws `ZipLimitError` past `limits`. */
  importZip(zip: Uint8Array, at?: string, limits?: ZipImportLimits): void;
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
  /**
   * Errors raised inside the preview: uncaught throws (`source: 'error'`), unhandled
   * rejections (`'rejection'`) and, in an Angular app only, `console.error` calls given an
   * Error object or an Angular-coded string (`'console'`) — how a failed Angular bootstrap,
   * Angular's ErrorHandler and its template checks (NG0303) report, with no uncaught error
   * at all. Other frameworks' `console.error` stays console output. A framework error code
   * is extracted: `{ code: 'NG0202', message: 'NG0202: …' }`.
   * At most 100 per page load.
   */
  onError(listener: (error: PreviewError) => void): () => void;
  /** The preview's `console.log/info/warn/error/debug` output (first 1,000 messages per page load). */
  onPreviewConsole(listener: (message: PreviewConsoleMessage) => void): () => void;
  /**
   * What the preview CSP blocked (or, report-only, would have): the directive and
   * the blocked origin, never a path. Each (page, directive, origin) once per
   * runtime, at most `CSP_VIOLATION_LIMIT` per page and
   * `CSP_VIOLATION_RUNTIME_LIMIT` in all — enforced here as well as in the page.
   * Reported by the preview page, which runs the app's code: diagnostics only,
   * never a security signal.
   */
  onCspViolation(listener: (violation: PreviewCspViolation) => void): () => void;
  /**
   * A snapshot of how this runtime loaded: phase timings, package-CDN requests,
   * requests per origin and the slowest, recent CSP violations and whether the
   * cache was cold or warm. Plain data; only what was measured (README › Diagnostics).
   */
  diagnostics(): RuntimeDiagnostics;
  /** Replace the scripts run in preview pages; open previews reload to pick them up. */
  setPreviewScripts(scripts: string[]): void;
  /**
   * Run a command — `node server.js`, `npm install`, `npm run dev`, `bfsh` for a
   * terminal — in its own Web Worker. Pass `{ terminal: { cols, rows } }` when
   * wiring it to xterm.js. `cwd` is project-relative like every other path here
   * (`/` is the project, `/packages/web` a folder in it; `..` cannot leave it);
   * the default is the project itself.
   */
  run(command: string, args?: string[], options?: ProcessOptions): RuntimeProcess;
  run(command: string, options?: ProcessOptions): RuntimeProcess;
  /** A process started listening (or a dev script handed off to the preview); `url` loads it in an iframe. */
  onServerListening(listener: (server: ServerAddress) => void): () => void;
  /** A virtual server opened or closed its port. */
  onPortChange(listener: (change: PortChange) => void): () => void;
  /**
   * Processes still running, with the ports their servers listen on. `cwd` is
   * project-relative; a process that changed directory out of the project (a
   * shell's `cd /tmp`) reports the absolute path it sees.
   */
  listProcesses(): ProcessInfo[];
  /**
   * Send an HTTP request to the virtual server on `port` from inside the runtime
   * (its own localhost, not the network) and wait for the whole response;
   * undefined when nothing listens there. `method` defaults to GET.
   */
  request(port: number, request: Partial<HttpRequestData> & { url: string }, caller?: SecurityContext): Promise<HttpResponseData | undefined>;
  /**
   * Serve raw TCP on a virtual port from the page (the database gateway does):
   * processes reach it with `net.connect(port)`; an HTTP request to it gets a
   * 502. `owner` (default the platform) is whose port it is: only callers the
   * port policy allows reach it. Throws `EADDRINUSE`.
   */
  listenTcp(port: number, accept: ConnectionHandler, owner?: SecurityContext): { port: number; close(): void };
  /** Open a raw TCP connection to whatever listens on `port`; undefined when nothing does (or `caller`, default the platform, may not reach it). */
  connect(port: number, caller?: SecurityContext): ByteChannel | undefined;
  /** The runtime's port policy: pass it as `startApplicationRuntime`'s `portPolicy`, so each application's `dependsOn` graph is in force while it runs. */
  readonly portPolicy: ServiceGraphPolicy;
  /**
   * Put an application's ingress (`spec.ingress`) in force on its preview origin
   * — and on the shared origin the instant preview lives on — until the returned
   * unregister: a page's same-origin request outside `/__bfwc/` goes to the
   * service its longest matching route names, under the port policy.
   * `startApplicationRuntime` calls it; the table never comes from a preview.
   */
  registerIngress(applicationId: string, spec: ApplicationSpec): () => void;
  /** End every process attributed to an application (or one of its services): pass the runtime as `startApplicationRuntime`'s `processes`. */
  killApplication(applicationId: string, serviceId?: string): void;
  /** The application was disposed (`startApplicationRuntime` calls it): drop its `pip install` record and training state. */
  forgetApplication(applicationId: string): void;
  /**
   * A database Worker, always on the HOST origin (relay mode included), so the
   * code a project runs — on the preview origin — has no path to the database's
   * storage; only gateway bytes cross. `dispose()` terminates the ones running.
   */
  createDatabaseWorker(): WorkerLike;
  /** The Security Shield's telemetry for this runtime: `events()` (the bounded ring), `health()` (enforcement and telemetry), and the reporter the chokepoints share. */
  security(): ShieldTelemetry;
  /**
   * Cookies virtual servers set, per port. A service worker cannot set cookies,
   * so the runtime keeps them and sends them back on later requests (and
   * WebSocket handshakes); inspect or `clear()` them here.
   */
  readonly cookies: PortCookieJars;
  dispose(): void;
}
