# Roadmap

The goal is a runtime that matches StackBlitz WebContainers where it matters and
beats it on openness, isolation requirements and extensibility. Each milestone
ships on its own.

## Shipped 

- (2026.10.0) Virtual file system with versioned files and change events.
- Per-file dev server: TS/TSX/JSX via a pluggable compiler (esbuild-wasm default).
- Resolution: relative paths, extension and `index` probing, the `.js`→`.ts`
  convention, tsconfig `paths` aliases.
- Bare imports → esm.sh with version pinning and shared-dependency dedupe.
- CSS (with document-safe `url()`), JSON, `?raw`, `?url` and asset imports.
- `import.meta.env` / `.env` (`VITE_*`) and CRA `process.env.REACT_APP_*`.
- Vite, Create React App and static projects; unsupported frameworks declined with a reason.
- Service-worker transport with re-attach after worker restarts.
- Preview errors forwarded to the host page.
- 2026.10.1: documents opt into COEP (`credentialless`), so a cross-origin-isolated host can frame the preview.
- 2026.10.2: live reload — editing any file reloads every frame showing the preview (`liveReload: false` turns it off); relay mode serves the preview from its own origin, isolated from the host's session (`relayUrl`).
- 2026.10.6: the public API uses its own vocabulary, not another runtime's: `startPreviewRuntime`, `writeTree` (one `FileTree` shape: contents or a nested tree, flat paths allowed), `run()` returning a `RuntimeProcess` (`pid`, `combinedOutput`, `stdin`, `wait()`, `kill()`, `resizeTerminal()`), `onServerListening` / `onPortChange`, and the `bfsh` shell.
- 2026.10.7: `fs.rename`, `fs.entries` (with kinds), `fs.watch(…, { under })`; `exportZip` / `importZip` (download a project, or snapshot and restore it with `node_modules`); `writeTree(files, at)`; `reload()`; `onPreviewConsole` and `previewScripts` / `setPreviewScripts`; `listProcesses()`; `.npmrc` scoped registries and auth tokens.
- 2026.10.8: streaming HTTP — a virtual server's head leaves on `writeHead` and each `res.write()` reaches the preview (page → service worker `ReadableStream`) and loopback clients as its own chunk, so Server-Sent Events, long-polling and chunked progress arrive live, and a client hanging up is seen by the server; WebSockets — `upgrade` listeners get a socket over a raw connection, so `ws`/socket.io run their own framing, and preview pages get a `WebSocket` shim that tunnels virtual-server URLs over a MessageChannel to the host page; cookies from virtual servers — a per-port jar in the host stores `Set-Cookie` (Path, Max-Age/Expires, HttpOnly kept from script), sends it back on requests and handshakes, and mirrors `document.cookie` on pages those servers served.
- 2026.10.8 (also): shell control flow — `if`/`while`/`until`/`for`/`case`, functions with `local`/`return`, groups and subshells, here-documents, `test`/`[`, `read`, `shift`, `break`/`continue`, `jobs`/`wait`; `pnpm` and `yarn` front ends; `createSnapshotStore()` keeps `exportZip` snapshots in IndexedDB across reloads; `exportZip({ include })`; virtual-server pages get the same error/console bridge and host scripts as dev-server pages.

- 2026.10.9: hot updates — an edit swaps stylesheets in place and, in React apps, re-renders the changed components keeping their state (Fast Refresh through the official `react-refresh` runtime, with the module graph deciding what to re-run and when a reload is needed); Sass (`.scss`/`.sass`) and Less, in files, CSS Modules and component `<style lang>` blocks, with `@use`/`@import` resolved from the project, `node_modules` or the package CDN; real CSS Modules scoping in the dev server (`:global`, `composes`, keyframes); package stylesheets imported from JS in the preview; `child_process.fork` message channels and `worker_threads` Workers (each its own process Worker); framework dev servers as real Node processes — `next dev` serves Next.js (its WebAssembly SWC, chosen through `process.versions.webcontainer`), `vite dev` serves SvelteKit on real Vite (esbuild-wasm's Go service over binary pipes, Rollup's WebAssembly build), and `vite`/`react-scripts start` run the installed tool when the project needs its own server; installs swap native-only tools for WebAssembly twins (`esbuild-wasm`, `@rollup/wasm-node`, napi-rs `-wasm32-wasi` siblings); binary-safe pipes, per-stream `stdio` inherit, `fs.read(0)` on stdin, children killed with their parent unless `detached`, real `ref`/`unref`; `vm` contexts as the code's global; top-level await of dynamic imports; requests without a `Host` header get one.
- 2026.10.10: `node:wasi` (WASI preview1 over the process's file system and stdio — `WASI` with `getImportObject`, `start`, `initialize`, preopens, files, `proc_exit`); installs prefer a napi-rs package's single-threaded `-wasm32-wasip1` binding, falling back to `-wasm32-wasi` only when none is published at that version (also when the package lists `-wasm32-wasi` itself), so current oxc-parser releases load without shared memory.
- 2026.10.12: `process.hrtime`/`uptime`/`cpuUsage`, `console.time`, `os.uptime`, `perf_hooks` and WASI clocks read the host clock captured at load, so a program that replaces `globalThis.performance` with one built on `process.hrtime` (esbuild-wasm ≤ 0.21's Go loader, i.e. Vite 5 builds) no longer recurses until the stack overflows.
- 2026.11.0: **Angular 17–20** (standalone components, JIT) runs unmodified `ng new` projects in the instant preview and `build()`. Angular is a component-compiler registry entry chosen from the project's `@angular/core` range. Before esbuild, a source transform inlines `templateUrl`/`styleUrl(s)` (CSS, Sass, Less), adds `ctorParameters` so constructor DI works without decorator metadata (`@Inject`/`@Optional`/… honoured, `T | null` → `T`), and adds the JIT metadata for signal `input`/`model`/`output` and signal queries. Angular sources compile with legacy decorators and `useDefineForClassFields: false`, and async/await is lowered for zone.js apps. `angular.json` `browser`/`main`, `index`, `styles` (including package stylesheets), `assets` and `polyfills` map to the entry, page and static folders, while AOT/SSR options are ignored. `zone.js` (when used), global styles and `@angular/compiler` load before the entry, and `@angular/*`, `rxjs`, `tslib` and `zone.js` are pinned to one set of ranges on the CDN. In Angular apps, `console.error`'d errors and `NG0xxx` messages reach `onError` with `source` and `code`; every preview error now carries `source`. `/check` flags template arrow functions, `@angular/ssr` imports, CLI-only builders and SSR/i18n options. A tsconfig `target` is honoured but never lowered below the defaults. Production builds re-root `url()`s in inlined component styles. Analog projects are declined (they need the Vite pipeline). Tested against real Angular 20 in jsdom: render, click, DI, signal inputs/outputs, zoneless, and bootstrap errors.
- 2026.11.5: **Security Shield** (Builderforce PRD 31 §W10). **Breaking for embedders**: see the README's [Upgrading to 2026.11.5](README.md#upgrading-to-2026115). This release adds:
  - **A preview CSP by default.** The service worker stamps every response it serves, in both modes, with a Content-Security-Policy whose only external sources are the default package CDN (`https://esm.sh`, when `cdn` is unset) and `previewEgress`. Map tiles, web fonts, public APIs and any other third-party origin are blocked until listed there. The policy is added beside the app's own, never replacing it, with `X-Content-Type-Options: nosniff`, `Origin-Agent-Cluster: ?1`, and `Set-Cookie` `Domain=` narrowed to the preview's exact host. `cspReportUrl` reports violations (`report-to bfwc-csp`).
  - **Same-origin previews refused by default.** `startPreviewRuntime` throws `PreviewShieldError` (`ingress.same_origin_refused`) unless `unprotectedSameOrigin: true` is set by name, or the preview runs on its own origin (`relayUrl`). A relay on the page's own origin, or one that is not https, is refused too.
  - **One origin per application.** `previewOrigin` (`previewOriginTemplate`, `previewOriginKey`) gives each application its own relay, process Workers, service worker and storage. An application started without one is refused (`ingress.app_origin_required`) unless `sharedPreviewOrigin: 'unprotected'` opts out. `workerPolicy` puts a signed `?policy=<id>` on process Worker script URLs, and a custom `node.createWorker` is handed `{ origin, policy }`.
  - **Attach integrity.** Each attach carries a fresh nonce chained to the previous one (`ingress.attach_rejected`). The service worker takes its egress and report endpoint only from its own script URL, never from a message.
  - **Security events.** The `./security` subpath (`SecurityEvent`), `security.sink`, and `runtime.security()` (`events()`, `health()`). Request bodies over 32 MiB on loopback HTTP and `runtime.request` are answered 413 (`ingress.body_too_large`).
  - **PHP and Python.** Unmodified PDO pgsql apps reach the browser database, and Python training services run their entry points. Each application keeps its own `pip install` record.
- 2026.11.7: **App manifest + local launcher** (Builderforce PRD 31 §W11). This release adds:
  - **The manifest module.** Core `./manifest` reads and checks `builderforce.json` v1:
    - services, resources, jobs, ingress and environments, each with a `production`/`non-production` tier and a debug flag;
    - typed issues, so an invalid file is reported, never dropped;
    - cron (time-zone and DST aware), the capability matrix, per-framework tier environment variables, `diagnosticsLevel`, deep environment overrides (prototype keys refused), `toApplicationSpec` and a JSON Schema.
  - **Ingress routing.** `ApplicationSpec.ingress` routes a frontend's relative `/api/…` (and absolute `http://localhost:<n>/`) requests to the declared service in the service worker. It only ever narrows the existing origin and port policy, never widens it.
  - **Dev servers in a sub-folder.** A dev-server handoff serves its own folder (`/web`) and reverts when it ends. Only the application's frontend can claim the shared preview, and a rival handoff is refused (`ingress.handoff_conflict`). `ng serve` now hands off to the instant preview.
  - **The local launcher.** `./launcher/server` adds `createLocalLauncher` and the CLI `bfwc-launch [dir] [--env] [--trust]`:
    - it serves on 127.0.0.1 only, over HTTPS;
    - certificates come from a local certificate authority restricted to `localhost`, `.localhost` and `127.0.0.1`, issued per host through SNI;
    - the CA is added to the user trust store only after the user approves;
    - the host page reads the project through a token-gated, contained file API and live sync;
    - each application gets its own `https://<key>.localhost` origin.
  - **Shared preview headers.** `./preview-headers` is now the single owner of the preview-origin headers and CSP.
- 2026.11.9: **Integrator feedback** (items 19–27, reported after the 2026.11.5 upgrade). 2026.11.8 was tagged but never published (its release tests failed). See the README's "What's new in 2026.11.9" and "Since 2026.11.9". **Embedders must update their `sw.js` gate:** this is the first runtime that honours `csp=report-only` from the service-worker URL, so the gate must be an allowlist of query keys that refuses `csp` and duplicate keys (the launcher and the Builderforce API now do). This release adds:
  - **CDN origins in the preview CSP.** A `cdn` factory declares `origins` (`createEsmShCdnFactory({ origin })` for esm.sh mirrors); they are validated and added to the egress, and a CDN without usable origins warns once per runtime instead of producing a blank page. Egress is exactly own origin + CDN origins + `previewEgress`.
  - **CSP violations in the host page.** `runtime.onCspViolation` reports directive and blocked origin only (never a path), deduped and capped in the page and again in the host. `previewCspMode: 'report-only'` for migrations.
  - **`runtime.diagnostics()`** and **`app.diagnostics()`**: phase timings, CDN and per-origin request totals, the slowest requests, recent violations, cold/warm cache, what could not be measured, and per-service state with the last log lines. Registration failures of `sw.js` name the configuration the gate may have refused.
  - **Laravel's `php artisan serve`** runs (it spawned `php -S` through `proc_open`, which php-wasm lacks — the cause of a blank Angular + Laravel preview). Laravel's semantics: global options, `host:port`, `SERVER_HOST`/`SERVER_PORT` from the environment or `.env`, `public/` docroot, Laravel's `server.php` router when installed.
  - **Output ends before state changes.** A process's output (`combinedOutput`, `app.logs(id)`) always delivers its last line before the service becomes ready, stopped or failed, on stop, restart and dispose too; a provider that never closes its stream is bounded by `stopTimeoutMs` with a logged note. Trailing bytes of an incomplete UTF-8 sequence are no longer dropped.
  - **A tested full-stack example.** Vite + React front end, a Laravel-style API (`composer install` → `artisan migrate` → `artisan serve`) and PGlite through `startApplicationRuntime`, with `/api` ingress; walkthrough in the README.
  - **Manifest command lines, Copy diagnostics, broader redaction.** A manifest `command` (and a job's `run.command`) is split into program and arguments; a line that needs a shell runs as `bfsh -c <line>` for a node service on the browser target and is a typed issue elsewhere (new codes `shell-command-unsupported`, `shell-command-with-args`, `command-backslash`); the node decline list sees inside shell lines. The launcher page gains "Copy diagnostics" (a redacted launch report), and `scrubCredentials` catches any `*_TOKEN`/`*_PASSWORD`/`*_KEY`-style key, quoted JSON keys and `Authorization` headers of any scheme.
  - **Docs.** The 2026.11.5 entry and upgrade guide, `attribution: false` as the one supported badge switch, the .NET bundle from npm (`@seanhogg/builderforce-webcontainers-dotnet`), and an "Assets fetched at runtime" table. Service failures surface through `app.onStateChange` / `app.onError` / `ApplicationStartError`, not a blank frame.
- 2026.11.10: **Launcher previews.** Imports are rewritten under a CSP without `'unsafe-eval'` (es-module-lexer decodes specifiers with `eval`), so a launcher preview no longer stays blank; a preview opened in its own tab goes through the launcher page's `/preview`, framed in the partition its service worker lives in.
- 2026.11.11: **The manifest in `.builderforce/` (item 28) and launcher hardening.** This release adds:
  - `.builderforce/builderforce.json` is canonical. A root `builderforce.json` or `bfwc.app.json` is read as a fallback, never written, and the launcher page shows a notice to move it (`legacyManifestLocation`). A manifest whose real path leaves the project (a symlinked `.builderforce`) is refused and never read (`manifestOutsideProject`); a `.builderforce` that is a file, or a manifest path that is a directory, counts as missing.
  - `paths` (`logs`, `diagnostics`, `methodology`) are validated: an empty or absolute path, a `..` segment or an unknown key is an `invalid-path` / `invalid-value` warning, and `parseManifest` leaves it out so the default applies.
  - The launcher header names the project after its directory (`LaunchInfo.projectDir`), never `.builderforce`.
  - A link from outside the browser (mail, chat) opens only a preview ROOT through `/preview`; a deeper path or a query is refused, so it cannot drive a request into the running app. The report token is compared in constant time with the launch token's helper.
  - String-literal export names are decoded without `eval` too.
- 2026.11.12: **Launcher: preview any service, and a Running / All filter.** Clicking a service that serves HTTP (not a database, not a port-less one-off) shows it in the preview pane; the heading and "Open in new tab" follow it, and the choice is held through a restart or a crash the runtime will recover from, falling back to the frontend with a notice only when the service stops for good. The Services panel shows **Running** by default — finished setup steps (`install-web`, `install-api`) are under **All (n)** — and a failed service is never hidden. 11 new `LauncherLabels` keys (`servicesFilter*`, `servicesHidden`, `servicesShowAll`, `noRunningServices`, `preview*`).
- 2026.11.24: **Autonomous agents inside the environment** (Builderforce PRD 31 §W12, phases 1–6). Manifest v1 takes `capabilities` and `agents`, declared by role or workload and never by model id (`agent-model-id`); a declaration above a `capabilities.agents` ceiling is a `policy-widening` error. `/agents` adds `createEnvironmentToolPort` (the `env.*` tools, allowlisted, idempotency-keyed and path- and service-checked), `createRuntimeAgents` (`runtime.agents.list|start|steer|cancel|status`), `createAgentsCapability` and `createChildRuntimes`, so an environment can run inside an environment with policies that only narrow its parent's. `/recovery` adds `createEnvironmentRecovery` and a one-holder runtime lease, restoring files, databases and services after a tab dies; agent runs resume from checkpoints at tool-result boundaries and never repeat a side effect. `/app` adds `createJobScheduler` for `jobs` and cron agent triggers. Tested: core 598 passed, browser 978 passed, both typecheck clean.

- 2026.11.25 — **Stable application identity (W10).** The manifest name reaches
  `ApplicationSpec` and, together with the project ID, identifies the running
  application. Different names distinguish applications with identical services.
  See the [release notes](CHANGELOG.md#whats-new-in-20261125).

- 2026.11.27 — **Host-delivered AI for services.** Backend `ai` resources get
  `AI_BASE_URL` from an owner-only gateway port served by
  `startApplicationRuntime` through a `hostRelay`. The local launcher relays
  models at a token-gated `/__bf/ai`, and takes `frameAncestors` and
  `ignoredDirs`. See the [release notes](CHANGELOG.md#whats-new-in-20261127).

- 2026.11.29 — **Code-scanner port, AI gateway lifecycle and state policy.** `security.scanner`
  (`CodeScanner`) vets installs, written files and spawns, with the shield reasons
  `code.blocked` and `code.scan_incomplete`. The AI gateway closes on `stop()`, and a
  child's relay can only narrow (`narrowHostRelay`, `aiCeiling`). `capabilities.state`
  sets how each kind of environment state persists. See the
  [release notes](CHANGELOG.md#whats-new-in-20261129).

## Shipped in 2026.10.3

- **Process isolation in relay mode.** Process workers (node, npm, the shell) start inside the relay frame, on the preview origin, from `process-worker.js`, so the code a project runs never shares the host's storage or session.
- **Vue and Svelte.** `.vue` (`@vue/compiler-sfc`, `<script setup>`, scoped styles)
  and `.svelte` (Svelte 5, and Svelte 4 without TS) compiled by the official
  compilers, loaded from a CDN on first use and pinned to the project's range.
  Vite + Vue and Vite + Svelte projects are accepted; Nuxt and SvelteKit are still
  declined.
- **Production build.** `runtime.build()` / core `buildProject()`: bundled,
  minified, content-hashed static site with extracted CSS, scoped CSS Modules,
  hashed assets, `public/` copied and production env inlined; packages stay on
  esm.sh (pinned, deduped). `Bundler` port with an esbuild adapter.
- **Type-checking.** `createChecker()` (`/check`): TypeScript in a Web Worker over
  the project's tsconfig (references, package `extends`), dependency types from
  esm.sh cached in Cache Storage, diagnostics as plain data.
- Root tsconfigs that only hold `references` (current Vite templates) now supply
  `paths` aliases from `tsconfig.app.json`.
- **`npm install` into the VFS.** Core `installPackages()`: semver resolution
  (own resolver), abbreviated packuments, npm-style hoisting with nesting on
  conflict, `npm:` aliases, peer and optional dependencies (native binaries for
  other platforms skipped), integrity checks, `node_modules/.bin`, lockfile v3
  written and reused (no metadata requests when it is current), `npm ci`.
  Tarballs cached in Cache Storage in the browser. Install scripts are skipped.
- **Node runtime.** `runtime.run('node', …)` runs Node programs, one Web Worker
  per process (a busy loop cannot freeze the page; `kill` terminates it).
  CommonJS and ES modules over the VFS with Node resolution (`exports`/`imports`
  conditions, `type: module`, `require.cache`), and shims for fs (+promises,
  streams, watch), path, events, buffer, util, process, os, url, querystring,
  string_decoder, timers, stream, assert, crypto (hashes/HMAC/random/pbkdf2),
  zlib, child_process, http/https, readline and the small modules. Servers listen
  on virtual ports, answered through the preview service worker at
  `/__bfwc/<id>/__port/<port>/` (`onServerListening`); localhost requests between
  processes are routed in-runtime; other `fetch`/`http.request` go to the network.
  Express installs from npm and serves (network e2e test).
- **Shell.** `run('bfsh', { terminal })` for xterm.js: line editing, history,
  completion, Ctrl-C/Ctrl-D; quotes, `$VAR`/`${VAR:-x}`, `$(…)`, globs, `&&`
  `||` `;` `&`, pipes, redirects; coreutils; `npm install|ci|run|start|test`,
  `npx`; `vite`/`react-scripts start` hand off to the in-browser dev server.

## Next

1. **Lint.** ESLint in the check worker. Not shipped with type-checking because
   ESLint 9 has no official browser build: it needs a bundled `Linter` (or
   `eslint-linter-browserify`) plus `typescript-eslint`'s parser and the project's
   flat config evaluated without Node — each needs proving in a real browser
   before it can be relied on.
2. **Type-check inside components.** `.vue` / `.svelte` imports are typed `any`
   today; checking their scripts needs `vue-tsc`/`svelte2tsx`-style transforms.
7. **Multi-page builds.** Only the main `index.html` is built; Vite's extra HTML
   entries and inline module scripts are left as written.
8. **Svelte rune modules.** `.svelte.js` / `.svelte.ts` files (`compileModule`).
9. **Offline package cache.** Cache CDN responses in Cache Storage, keyed by
   resolved version, so a reload makes no network requests.
10. **Self-hosted package proxy.** A reference `PackageCdn` that serves npm
   tarballs, transformed to ESM, from your own infrastructure.

## Full-stack applications (planned)

Planned work: run a frontend, an API and a Postgres database (PGlite in its own Worker) as one application.
- **Entry point:** `startApplicationRuntime(spec)` on a new `./app` subpath.
- **Database access:** through `net.createConnection` to virtual TCP ports and a Postgres wire gateway, so unmodified `pg` / Drizzle work.
- **Prerequisite:** item 18 (shared copy-on-read VFS).

The design and phases are in Builderforce PRD 31 §W9. Builderforce's run loop uses this as its browser target.

**Runtimes after Node** (committed): Python (Pyodide), PHP (php-wasm), .NET (browser-wasm + Roslyn) and Rust (WASI). Each is a `RuntimeProvider` adapter that reaches the shared database through virtual TCP.

**Python also runs LLM training** (LoRA/QLoRA on small models). It uses a PyTorch-style `torch` module backed by one WebGPU tensor engine with autograd, in `@webdit/torch`, so the math runs on the GPU.

## Toward a full Node runtime

Known limits of what shipped, roughly in the order they are worth closing:

11. **WebSocket clients in Node programs.** Servers take WebSockets (and the
   preview connects to them); a Node program dialling one (`ws`'s client,
   Node's global `WebSocket`, `http.request` with `Upgrade`) has no loopback
   upgrade path yet.
12. **ES module live bindings.** ESM is rewritten to the CommonJS wrapper;
   imported bindings are snapshots, so a cycle that reads a `const` before the
   other module finished initialising sees `undefined`. Dual packages load their
   CommonJS build to avoid the transform.
13. **Synchronous child processes** (`execSync`, `spawnSync`) throw: blocking a
   worker on another needs `Atomics.wait`, i.e. SharedArrayBuffer and cross-origin
   isolation, which this runtime refuses to require.
14. **Install scripts and native addons.** `postinstall` is skipped; `.node`
   addons cannot load. Packages with a WASM fallback (esbuild-wasm, @swc/wasm)
   work; ones that only ship native binaries (sharp, better-sqlite3) do not.
15. **Framework dev servers: Nuxt.** Next.js and SvelteKit run (2026.10.9).
   SvelteKit's phantom start-up restarts are fixed in 2026.10.11: projects live
   at `/home/project` (`root`), not `/`, where chokidar recorded `basename('/')`
   as a child and unwatched the project on every rescan.
   Nuxt 3 does not run: it pins `oxc-parser ^0.143`, whose only WebAssembly build
   is the threaded `wasm32-wasi` one (single-threaded `-wasm32-wasip1` bindings
   start at 0.152), and that needs SharedArrayBuffer, so cross-origin isolation,
   which this runtime refuses to require. Nuxt 4 (4.6.2) installs but stalls
   silently after "Starting Nuxt..." (with `--no-fork`, no port, no error). Leads:
   the runtime reports Node 20.18 while Nuxt 4 wants ^22.21, and `oxc-parser`
   (a peer of `oxc-walker`) was not installed at the top level. In the
   in-process kernel (`packages/core/scripts/frameworks-diag.ts`) `nuxt dev` does not
   wait, it spins: the thread is CPU-bound and never yields (no output, timers
   never fire), so the next step is a CPU profile of that loop.
   Framework start-up is also slow (about 20–35 s to Next's first page) because
   each process receives the whole file system; see item 18.
17. **Shell gaps.** No `fg`/`bg` (a background job cannot be brought back to
   the terminal), no arithmetic `$(( ))`; `npx` installs only what has a `bin`.
18. **Process start-up cost.** Each process receives a full snapshot of the file
   system; a shared, copy-on-read store (or OPFS) would make spawning O(1).

## Integrator feedback (2026-11-21)

Reported by the Universal Code VS Code extension, which runs generated apps in a
webview through `/preview`, after its upgrade to 2026.11.5. Each item below was
checked against the source. Items 19–27 shipped in 2026.11.9 and item 28 in 2026.11.11 (see "Shipped").

29. **`createLocalLauncher` gaps for hosts that wrap it as `/preview`.** Checked
   against `packages/browser/src/launcher/server/` on 2026-11-21; `assetsDir`
   (earlier), `frameAncestors` and `ignoredDirs` (2026.11.27) are done:
   - No API ingress or same-origin `/api` proxy to a host-side service.
   - Manifest `setup[]` steps, `startPage`, and a static fallback when there is
     no manifest are not supported. *Needs a Builderforce make.md manifest-shape revision first.*
   - No token-protected `POST /__bf/report`, and no `onReport`/`onLog`/`onError`
     callbacks. Reports are written to the manifest's diagnostics folder (`paths.diagnostics`, shipped in 2026.11.11).
   - Manifest `egress[]` is not validated by the launcher. *Needs a Builderforce make.md manifest-shape revision first.*
   - CDN pins cannot be passed through.
   - LAN access needs a decision (the launcher is 127.0.0.1-only today, which is
     the safe default).
   Not applicable here: the reported unauthenticated `/__dotnet/*` route is in the
   integrator's own wrapper. This launcher serves only the public .NET bundle under
   `/dotnet/`, contained to the bundle directory.

- Unreleased: a `CodeScanner` port on the Security Shield — installs, process writes and spawns are checked against an embedder-supplied scanner (`security.scanner`), refusing blocked code with `code.blocked` and reporting unfinished scans as `code.scan_incomplete`.

## Principles

- Ports over hard dependencies: compiler, package CDN and transport are swappable.
- Never require cross-origin isolation.
- Decline what we cannot run, with a reason; never show a half-broken preview.
