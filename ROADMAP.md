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
15. **Framework dev servers: Nuxt, and SvelteKit's restarts.** Next.js and SvelteKit
   run (2026.10.9). SvelteKit on real Vite restarts once or twice shortly after
   start ("vite.config.js changed") although only Vite's own
   `vite.config.js.timestamp-*.mjs` bundle is created and removed beside it; a
   request landing mid-restart gets Vite's SSR "not yet fully initialized" 500 and
   the next one renders. Needs a trace of chokidar's own events to find which
   watcher answer it misreads. Nuxt does not run: its
   parser, `oxc-parser`, has only native builds and a `wasm32-wasi` build that
   needs `node:wasi` with threads over shared memory — SharedArrayBuffer, so
   cross-origin isolation, which this runtime refuses to require. Unblocked by a
   single-threaded WASI build of oxc-parser (or a JS parser fallback upstream).
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
