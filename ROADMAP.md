# Roadmap

The goal is a runtime that matches StackBlitz WebContainers where it matters and
beats it on openness, isolation requirements and extensibility. Each milestone
ships on its own.

## Shipped (2026.10.0)

- Virtual file system with versioned files and change events.
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

## Principles

- Ports over hard dependencies: compiler, package CDN and transport are swappable.
- Never require cross-origin isolation.
- Decline what we cannot run, with a reason; never show a half-broken preview.
