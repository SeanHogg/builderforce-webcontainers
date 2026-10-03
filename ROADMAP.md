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

## Shipped (unreleased)

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
- **Node runtime.** `runtime.spawn('node', …)` runs Node programs, one Web Worker
  per process (a busy loop cannot freeze the page; `kill` terminates it).
  CommonJS and ES modules over the VFS with Node resolution (`exports`/`imports`
  conditions, `type: module`, `require.cache`), and shims for fs (+promises,
  streams, watch), path, events, buffer, util, process, os, url, querystring,
  string_decoder, timers, stream, assert, crypto (hashes/HMAC/random/pbkdf2),
  zlib, child_process, http/https, readline and the small modules. Servers listen
  on virtual ports, answered through the preview service worker at
  `/__bfwc/<id>/__port/<port>/` (`server-ready`); localhost requests between
  processes are routed in-runtime; other `fetch`/`http.request` go to the network.
  Express installs from npm and serves (network e2e test).
- **Shell.** `spawn('jsh', { terminal })` for xterm.js: line editing, history,
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
3. **Style preprocessors.** `<style lang="scss">`, `.scss`/`.less` imports
   (sass's pure-JS build from the CDN).
4. **Hot module replacement.** Push a change event to the preview over a
   BroadcastChannel; React Fast Refresh via `react-refresh` from the CDN.
5. **Real CSS Modules in the dev server.** The build scopes them; the dev server
   still exports an identity map, so class names must not collide in preview.
6. **Package stylesheets in the dev server.** `import 'bootstrap/dist/css/x.css'`
   works in builds (it becomes a CSS `@import`), not yet in the preview.
7. **Multi-page builds.** Only the main `index.html` is built; Vite's extra HTML
   entries and inline module scripts are left as written.
8. **Svelte rune modules.** `.svelte.js` / `.svelte.ts` files (`compileModule`).
9. **Offline package cache.** Cache CDN responses in Cache Storage, keyed by
   resolved version, so a reload makes no network requests.
10. **Self-hosted package proxy.** A reference `PackageCdn` that serves npm
   tarballs, transformed to ESM, from your own infrastructure.

## Toward a full Node runtime

Known limits of what shipped, roughly in the order they are worth closing:

11. **Streaming HTTP.** Responses are buffered whole, so Server-Sent Events,
   long-polling and chunked progress arrive at once; WebSockets (`ws`, socket.io)
   have no transport. Needs a streamed MessagePort body and a WebSocket shim.
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
15. **Next.js / Nuxt / SvelteKit dev servers.** Feasible in principle (they are
   Node HTTP servers), blocked today by: SWC/esbuild/lightningcss native binaries
   (need WASM builds wired as fallbacks), `worker_threads` (Next spawns workers),
   streaming responses (11), and their size (hundreds of MB of `node_modules`
   mirrored into each process worker). Real Vite is blocked by the same native
   esbuild/rollup binaries, which is why `vite` hands off to the built-in server.
16. **Cookies from virtual servers.** A service worker cannot set `Set-Cookie`,
   so session cookies issued by an Express app do not stick.
17. **Shell gaps.** No functions, `if`/`for`/`while`, here-docs, subshell `( )`
   or job control (`fg`, `bg`); `npx` installs only what has a `bin`.
18. **Process start-up cost.** Each process receives a full snapshot of the file
   system; a shared, copy-on-read store (or OPFS) would make spawning O(1).

## Principles

- Ports over hard dependencies: compiler, package CDN and transport are swappable.
- Never require cross-origin isolation.
- Decline what we cannot run, with a reason; never show a half-broken preview.
