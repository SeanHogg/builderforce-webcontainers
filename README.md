# BuilderForce WebContainers

> Part of [Builderforce open source](https://builderforce.ai/open-source): the MIT projects Builderforce.ai is built on.

An open, forkable in-browser dev runtime. Hand it a project as files; it serves a
live preview in an iframe, with TypeScript, JSX, CSS, JSON and npm packages working
like they do under Vite, all running in the user's browser.

It is the runtime behind [BuilderForce.ai](https://builderforce.ai)'s canvas
previews, built to be forked.

| Package | What it is |
|---|---|
| [`@seanhogg/builderforce-webcontainers-core`](packages/core) | The dev server, runtime-agnostic and testable in Node: virtual file system, module resolution, import rewriting, CSS/JSON/asset modules, project detection |
| [`@seanhogg/builderforce-webcontainers`](packages/browser) | The browser runtime: boots the dev server in a page and serves it to an iframe through a service worker. Compiles with esbuild-wasm. |

## Why another one

| | BuilderForce WebContainers | StackBlitz WebContainers |
|---|---|---|
| Licence | MIT. Fork it, ship it, sell it. A small badge is on by default; `attribution: false` switches it off ([Attribution](#attribution)). | Proprietary. Free tier non-commercial, attribution required. |
| Session cap | None | 25,000 API sessions/month on the free tier |
| Cross-origin isolation (COOP/COEP) | **Not required**: embeds and third-party scripts keep working | Required |
| Compiler / package source | Pluggable ports: swap esbuild for SWC, esm.sh for your own mirror | Fixed |
| Errors | Uncaught errors in the preview are posted to the host page | — |
| Load diagnostics | `runtime.diagnostics()`: phase timings, package CDN and per-origin requests, slowest origins, cold/warm cache, and what could not be measured ([Diagnostics](packages/browser/README.md#diagnostics)) | — |
| Blocked-request reports | `runtime.onCspViolation(listener)`: the directive and origin the preview's CSP blocked, no paths ([Preview origin headers](packages/browser/README.md#preview-origin-headers)) | — |
| Production build, type-check | In the browser: `runtime.build()`, `createChecker()` | Via `npm run build` / `tsc` in the container |
| Node.js programs and servers, `npm install`, shell | Yes: one Web Worker per process, still no COOP/COEP (limits in [ROADMAP](ROADMAP.md)) | Yes |

It runs **frontend apps** (Vite with React, Vue or Svelte, Create React App,
static sites), which it previews, builds for deployment and type-checks; and
**Node programs**: `npm install` from the real registry, Node scripts and
Express-style servers, and an interactive shell for a terminal. Framework dev
servers run as the real thing: `next dev` serves a Next.js app from its own
process, with Next's WebAssembly compiler (`@next/swc-wasm-nodejs`) standing in
for the native one, and `vite dev` runs SvelteKit on real Vite. Installs swap native-only build tools for their WebAssembly
twins (`esbuild` → `esbuild-wasm`, `rollup` → `@rollup/wasm-node`, napi-rs
`-wasm32-wasip1` builds first, over `node:wasi`, then `-wasm32-wasi`). Nuxt does
not run yet: Nuxt 3's parser has only a threaded WebAssembly build, which needs
cross-origin isolation, and Nuxt 4 stalls during start-up (see the
[ROADMAP](ROADMAP.md)). The roadmap is how it closes the rest of the gap.

## What's new in 2026.11.10

- **Launcher previews render.** A React app run by `bfwc-launch` showed an
  empty frame with only the badge: the dev server sent its modules with bare
  imports (`react`, `react/jsx-runtime`) left in, and the browser refused them.
  es-module-lexer decodes each import specifier with `eval`, which the launcher
  page's CSP forbids, so every specifier came back empty and none was rewritten.
  Specifiers are now decoded without `eval`, so imports
  are rewritten to the package CDN under any CSP. The CSP itself is unchanged.
- **"Open in new tab" works.** A preview opened in its own tab (the launcher's
  link, or the `Local:` URL Vite prints) answered "Not found.". Preview origins
  are a different site from the launcher page, so the relay's service worker
  lives in the launcher page's storage partition, and a top-level tab on a
  preview origin has none. The preview origin now redirects such a tab to the
  launcher page's new `/preview?src=<url>`, which frames the preview full size
  under the same partition, served by the running launcher tab. The page runs
  no script, holds no token, and frames only this launcher's preview origins.
  Only the user can open it, never another site: the redirect happens only for
  a tab the user opened (`Sec-Fetch-Site: none`) and carries a 60-second ticket
  signed for that one URL, and `/preview` otherwise answers only the launcher
  page's own link.
  A framed preview that loads before its service worker is active gets a small
  bootstrap page (one hash-pinned script) that reloads once the worker is
  active, or says the preview is not running. Three new overridable labels:
  `previewStarting`, `previewNotRunning` and `previewInvalid`.
- **The manifest lives in `.builderforce/`.** `.builderforce/builderforce.json`
  is the canonical manifest (`./manifest` exports `locateManifest` and
  `manifestWritePath`; `bfwc-launch` reads it there). A root `builderforce.json`
  or `bfwc.app.json` is a deprecated fallback: still read, never written. The
  manifest gains `paths` (`logs`, `diagnostics`, `methodology`), each
  project-relative inside the project, defaulting under `.builderforce/`.

## What's new in 2026.11.9

- **A manifest `command` is a command line.** `npm install`, `npm run dev` and
  `uvicorn main:app --host 0.0.0.0` are split into the program and its
  arguments, ahead of any `args`. Before, the whole line was taken as one
  program name and the service exited 127 ("command not found"). Quotes group
  words (`"/path with space/node" server.js`). A job's `run.command` is read
  the same way.
- **Shell lines.** A line that needs a shell (`&&`, `|`, redirects,
  `FOO=1 cmd`, `$VAR`) runs as `bfsh -c <line>` for a node service on the
  browser target. Anywhere else it is a typed issue, not a mangled command.
- **New manifest issue codes.** `shell-command-unsupported` (the line needs a
  shell its runtime or target does not have), `shell-command-with-args` (a
  shell line cannot also take `args`; put the whole line in `command`) and
  `command-backslash` (a warning: an unquoted `\` the shell drops, so use
  forward slashes in paths). An unterminated quote is an `invalid-value`.
- **The node decline list sees inside shell lines.** `cd infra && docker compose up`,
  `sh -c '…'`, `bash -e -c '…'` and command substitutions are unwrapped, so a
  declined program (Docker, `wrangler dev`) is declined wherever it appears.
- **"Copy diagnostics" on the launcher page.** One button copies a report of
  the launch: header, status, services, problems and every buffered log line,
  with credentials redacted. Its text comes from three new overridable labels:
  `copyDiagnostics`, `copyDiagnosticsDone` and `copyDiagnosticsFailed`.
- **Broader credential redaction.** The shield's `scrubCredentials`, which
  scrubs security event evidence (`scrubString`) and the copied diagnostics
  report, now catches any key ending in a secret word (`GITHUB_TOKEN=`,
  `DB_PASSWORD=`, `OPENAI_API_KEY:`), quoted JSON keys
  (`"token":"…"`), and `Authorization` headers of any scheme.
- **Diagnostics.** `runtime.diagnostics()` returns one load report: phase
  timings (runtime start, service worker ready, compiler load, preview first
  paint), package CDN request count, total time and errors, requests per
  origin, the slowest requests (origin only, never a URL), recent CSP
  violations, a cold or warm cache, and `unavailable` for what could not be
  measured. See [Diagnostics](packages/browser/README.md#diagnostics).
- **CSP violations on the host page.** `runtime.onCspViolation(listener)`
  reports which origin the preview's policy blocked and under which directive.
  Paths are never forwarded; reports are deduplicated and capped. See
  [Preview origin headers](packages/browser/README.md#preview-origin-headers).
- **Report-only previews for migrations.** `previewCspMode: 'report-only'`
  reports violations without blocking. It turns the protection off, so your
  `sw.js` gate must allow it deliberately (Builderforce never does).
- **A custom package CDN joins the preview CSP.** A `cdn` factory declares
  `origins` and the runtime adds them to the preview egress;
  `createEsmShCdnFactory({ origin })` does this for an esm.sh mirror. A custom
  CDN with no `origins` logs one warning instead of producing a blank page.
  See [Since 2026.11.9](#since-2026119).
- **Laravel's `php artisan serve` runs.** A Vite frontend, a Laravel API and
  Postgres start end to end as one application, and a setup step's output
  (`composer install`, `npm install`) ends with its last line before a service
  changes state. See
  [Example: a Vite front end, a Laravel API and Postgres](packages/browser/README.md#example-a-vite-front-end-a-laravel-api-and-postgres).
- **Hosting.** The .NET runtime bundle installs from npm as
  `@seanhogg/builderforce-webcontainers-dotnet` ([.NET](packages/browser/README.md#net)),
  and [Assets fetched at runtime](#assets-fetched-at-runtime) lists every
  origin the runtime downloads from, for strict-CSP and offline hosts.

## Quick start

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

// 1. Serve node_modules/@seanhogg/builderforce-webcontainers/dist/sw.js at /__bfwc/sw.js
// 2. Start, write files, preview:
const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', unprotectedSameOrigin: true, id: 'my-project' });
runtime.writeTree({
  'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }),
  'index.html': '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
  'src/main.tsx': `import { createRoot } from 'react-dom/client';
createRoot(document.getElementById('root')!).render(<h1>Hello</h1>);`,
});

if (runtime.profile().supported) iframe.src = runtime.url;
runtime.onError((e) => console.warn('preview crashed:', e.message));

// Edits reach every open preview: styles swap in place, React components
// re-render keeping their state (Fast Refresh), anything else reloads.
runtime.fs.writeFile('/src/main.tsx', '...');
```

Requirements: a secure context (https or localhost) for the service worker. That
is all. `unprotectedSameOrigin: true` is required for this mode: the Security
Shield refuses to boot a preview on your page's own origin otherwise
(`PreviewShieldError`, reason `ingress.same_origin_refused`). For anything but
code your own user wrote, use [relay mode](#isolating-the-preview-relay-mode).

### Upgrading to 2026.11.5

2026.11.5 added the Security Shield. If you upgrade from 2026.11.4 or earlier
without changing your code, three things can break:

1. **Same-origin previews are refused.** `startPreviewRuntime({ serviceWorkerUrl })`
   throws `PreviewShieldError` (`ingress.same_origin_refused`). You have two
   choices:
   - Opt in by name with `unprotectedSameOrigin: true`. Do this only for code
     your own user wrote.
   - Serve the preview from its own origin with `relayUrl`
     ([relay mode](#isolating-the-preview-relay-mode)). The relay must be https
     and must not be on your page's origin.
2. **Previews get a default CSP, and it blocks third-party origins.** The
   service worker stamps a Content-Security-Policy on every response it serves.
   This applies in both modes. The policy allows the preview's own origin and
   these external sources:
   - the package CDN: `https://esm.sh` when `cdn` is unset (with a custom `cdn`
     in 2026.11.5, list your CDN's origin yourself);
   - whatever you list in `previewEgress`.

   Everything else a previewed app loads or fetches is blocked: map tiles, web
   fonts, public APIs, analytics. The app may render blank or half-styled. To
   allow a source, list it in `previewEgress` as an https or wss origin. A `*.`
   wildcard is allowed. Paths are not. The runtime keeps at most 64 sources and
   silently drops anything else (an `http:` origin, a path, a keyword). The
   runtime adds the policy beside any CSP the app sets, so it can only tighten
   the app's own. `previewEgress` can also be a function that answers per
   application (`undefined` means the workspace's previews).
3. **Applications need their own origin.** In relay mode,
   `startApplicationRuntime` refuses an application (`ingress.app_origin_required`)
   unless you set `previewOrigin`
   ([one origin per application](#one-origin-per-application-previeworigin)) or
   opt out with `sharedPreviewOrigin: 'unprotected'`. In same-origin mode,
   `unprotectedSameOrigin: true` already covers this.

To see what the policy blocks, set `cspReportUrl`. Browsers then send
violation reports to that endpoint (`report-to bfwc-csp`, with
`Reporting-Endpoints`). It must be an absolute https URL with no credentials,
quotes, commas, semicolons or spaces, or it is ignored. Reports go to your
server, not to the host page.

Before (2026.11.4):

```ts
const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId });
```

After (2026.11.5). Same origin, for trusted code only:

```ts
const runtime = await startPreviewRuntime({
  serviceWorkerUrl: '/__bfwc/sw.js',
  unprotectedSameOrigin: true, // previews can read this page's cookies and storage
  id: projectId,
  // What the previewed apps may reach besides esm.sh: origins only, no paths.
  previewEgress: ['https://tile.openstreetmap.org', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://api.example.com'],
  cspReportUrl: 'https://api.example.com/csp-reports',
});
```

Or isolated, for AI-written or third-party code:

```ts
const runtime = await startPreviewRuntime({
  relayUrl: 'https://preview.example.com/__bfwc/relay.html',
  id: projectId,
  previewEgress: ['https://tile.openstreetmap.org', 'https://api.example.com'],
  cspReportUrl: 'https://api.example.com/csp-reports',
});
```

In relay mode, the preview origin serves its files with the headers in
[Preview origin headers](packages/browser/README.md#preview-origin-headers).

#### Since 2026.11.9

- A custom `cdn` factory may declare `origins`. The runtime adds them to the
  preview CSP automatically. esm.sh's default factory declares
  `https://esm.sh`. A custom CDN without `origins` logs one console warning,
  and you list its origin in `previewEgress` as before.
- `runtime.onCspViolation(listener)` forwards in-page CSP violations to the
  host page. Each one carries the directive and the blocked origin.
- `previewCspMode: 'report-only'` reports violations without blocking anything.
  Use it while you migrate.
- `runtime.diagnostics()` returns one load report, CSP violations included.
- **Check your `sw.js` gate.** 2026.11.9 is the first runtime that honours
  `csp=report-only` in the `sw.js` URL, and preview code can register `sw.js`
  again with any query. So every embedder's gate must be an allowlist of the
  query keys it checks. It must refuse `csp`, unless you deliberately run
  report-only, and refuse any key named twice.
- A custom CDN's `origins` now join each relay origin's egress too, so your
  `sw.js` gate (and any signed policy) must grant them. If it does not, `sw.js`
  is refused and the runtime fails to start, naming the egress. See the `sw.js`
  entry in
  [Preview origin headers](packages/browser/README.md#preview-origin-headers).

### Vue and Svelte

`.vue` and `.svelte` files work with no setup. The first time a project needs one,
the runtime loads the official compiler from a CDN (`@vue/compiler-sfc`'s browser
build from jsDelivr, `svelte/compiler` from esm.sh), pinned to the project's own
`vue` / `svelte` range so compiler and runtime agree. Vue `<style scoped>` and
Svelte's component CSS are scoped as usual, and `<style lang="scss|sass|less">`
blocks are compiled first. Pass `components` to `startPreviewRuntime` to supply
compilers yourself. Not yet: TypeScript in Svelte 4 (Svelte 5 handles it).

### Styles and hot updates

* **Sass and Less.** `.scss`, `.sass` and `.less` files — imported from code,
  linked from HTML, or as component `<style lang>` — compile with the official
  pure-JS Sass and Less, loaded from a CDN the first time a project needs them and
  pinned to its `sass` / `less` range. `@use` / `@import` find partials in the
  project, an installed `node_modules`, or the package on jsDelivr
  (`@use 'bootstrap/scss/functions'` works before `npm install`). `styles` swaps
  the compilers.
* **CSS Modules** (`*.module.css|scss|sass|less`) are scoped in the preview as in
  the build: per-file class names, `:global` / `:local`, `composes` (local, from
  another module, from global), local `@keyframes`; the default export is the
  class map, plus a named export per class.
* **Package stylesheets** imported from code (`import 'bootstrap/dist/css/bootstrap.css'`)
  load in the preview from the package CDN, and `@import 'pkg/x.css'` in your own
  CSS does too.
* **Hot updates** (`hot`, on by default). An edit to a stylesheet swaps it without
  reloading. In a React app, an edit to a component re-renders it in place with
  its state kept, through the official `react-refresh` runtime; an edit to a
  module that is not a component re-runs the components that import it. The page
  reloads when that cannot be done safely: the entry changed, a component's hooks
  changed, or files were added or removed. `server.planUpdate(changes)` is the
  decision, if you drive the dev server yourself.

### Building for deployment

`runtime.build()` is `npm run build` in the page: it bundles and minifies the app
with esbuild-wasm and returns a static site you can upload anywhere.

```ts
const { files } = await runtime.build({ base: './' }); // or '/app/', 'https://cdn.example.com/site/'
for (const { path, data } of files) upload(path, data); // index.html, assets/main-3F2A9C.js, …
```

* `index.html` loads hashed bundles; CSS is extracted (CSS Modules are scoped); assets
  imported from code or CSS get content-hashed names; `public/` is copied as-is.
* Packages are **not** bundled: they stay on esm.sh at the same pinned, deduped URLs
  the preview uses (production builds), so the site needs no `node_modules`.
* `import.meta.env` (`MODE: 'production'`, `.env.production`) and CRA's
  `process.env.REACT_APP_*` / `PUBLIC_URL` are inlined.

Outside a booted runtime, call `buildProject({ files, bundler })` from the core
with any `Bundler` (`createEsbuildBundler(esbuild)` in Node, `createEsbuildWasmBundler()`
in the browser).

### Type-checking

```ts
import { createChecker, formatDiagnostic } from '@seanhogg/builderforce-webcontainers/check';

const checker = createChecker(); // one Web Worker; keep it for the session
const { diagnostics } = await checker.check(runtime.fs);
// [{ file: 'src/App.tsx', line: 3, column: 7, code: 2322, category: 'error', message: '…' }]
diagnostics.forEach((d) => console.log(formatDiagnostic(d)));
```

The worker runs TypeScript (pinned, loaded from jsDelivr) over the project's
tsconfig, following `references` and `extends` (`@vue/tsconfig`, `@tsconfig/svelte`
are fetched). With no tsconfig it uses Vite's strict defaults with `jsx: react-jsx`.
Dependency types come from esm.sh's `X-TypeScript-Types` and are cached in Cache
Storage. `vite/client`, asset imports and `.vue` / `.svelte` imports are typed by
built-in declarations; component internals are not checked yet. A package with no
types is treated as `any` and listed in `untypedPackages` rather than reported.
Bundlers pick up the worker (`new URL('./worker.js', import.meta.url)`); otherwise
serve `dist/check/worker.js` and pass `workerUrl`. In Node, use
`typecheckProject(ts, files, { fetch })` from `@seanhogg/builderforce-webcontainers-core/check`.

### Node.js, npm and a terminal

`runtime.run()` starts a command and hands back a `RuntimeProcess`: its `pid`,
a `combinedOutput` stream (stdout and stderr as written), a `stdin` stream,
`wait()` for the exit code, `kill()` and `resizeTerminal()`.

```ts
const install = runtime.run('npm', ['install']);
install.combinedOutput.pipeTo(new WritableStream({ write: (chunk) => console.log(chunk) }));
if ((await install.wait()) !== 0) throw new Error('install failed');

runtime.onServerListening(({ url }) => (iframe.src = url)); // …/__bfwc/<id>/__port/3000/
runtime.run('node', ['server.js']);

// An interactive shell for xterm.js:
const shell = runtime.run('bfsh', { terminal: { cols: term.cols, rows: term.rows } });
shell.combinedOutput.pipeTo(new WritableStream({ write: (data) => term.write(data) }));
const keys = shell.stdin.getWriter();
term.onData((data) => keys.write(data));
term.onResize(({ cols, rows }) => shell.resizeTerminal(cols, rows));
```

`runtime.onPortChange(({ port, type, url }) => …)` reports every port opening
and closing, for a host that lists running servers.

* **Processes.** Each process runs in its own Web Worker (`dist/node/worker.js`,
  found beside the module like the check worker; or pass `node: { workerUrl }`),
  so a busy loop never freezes the page and `kill()` always works (the worker is
  terminated after a 2s grace). A worker starts from a snapshot of the files;
  its writes sync back to `runtime.fs` and on to every other process.
* **Node.** CommonJS and ES modules with Node's resolution (`exports`/`imports`
  conditions, `type: module`), and shims for `fs`, `path`, `events`, `buffer`,
  `util`, `process`, `os`, `url`, `stream`, `crypto`, `zlib`, `http`/`https`,
  `child_process`, `readline` and the rest. It reports itself as Node 20 on Linux.
* **Servers.** `http.createServer().listen(port)` registers a virtual port; the
  preview service worker routes `/__bfwc/<id>/__port/<port>/…` to it (any method,
  with its body) and `onServerListening` fires. Absolute URLs (`/style.css`,
  `fetch('/api')`) from such a page are mapped back to its server. `localhost`
  requests between processes stay inside the runtime; anything else goes through
  the browser's `fetch`, so CORS applies.
* **Streaming.** Responses stream: the head leaves on `writeHead` (or the first
  write) and every `res.write()` reaches the preview as its own chunk, so
  Server-Sent Events, long-polling and chunked progress arrive as they happen —
  in the preview (the page relays the chunks to the service worker, which answers
  with a `ReadableStream`), and over loopback (`http.get`, `fetch`). When the
  preview stops reading (an `EventSource` closed, a page left), the server sees
  `aborted`/`close` on the request. A browser may stop an idle service worker
  under a very long-lived stream; `EventSource` reconnects by itself.
* **WebSockets.** An `upgrade` listener on the server gets a socket over a raw
  connection (`write`, `on('data')`, `end`, `destroy`, `setNoDelay`,
  `setTimeout`, `remoteAddress`), so `ws` — and socket.io, which runs on it — do
  their own handshake and framing unchanged. A service worker cannot intercept a
  WebSocket, so every preview page gets a small `WebSocket` replacement: a URL
  naming a virtual server (`ws://localhost:3000/…`, a relative URL, or
  `ws://${location.host}/…` from a page that server served) is tunnelled over a
  MessageChannel to the runtime's page (`parent`, else `opener`), which connects
  to the server and relays text and binary frames, server pushes and close
  codes. Any other URL gets the browser's own `WebSocket`. A preview opened in a
  tab with no link back to the runtime's page cannot tunnel.
* **Cookies.** A service worker cannot set `Set-Cookie`, so the runtime keeps a
  jar per port (`runtime.cookies`): cookies a server sets are stored (`Path`,
  `Max-Age`/`Expires`, deletion) and sent back on later requests and WebSocket
  handshakes, in place of the browser's own. On pages a virtual server served,
  `document.cookie` shows the non-`HttpOnly` ones and assignments go back to the jar.
* **npm.** `npm install|i|ci|uninstall|run|start|test|ls|init` and `npx`, against
  registry.npmjs.org (`node: { registry }` changes it): semver resolution,
  npm-style hoisting, `.bin` links, `package-lock.json` v3 written and reused,
  tarballs cached in Cache Storage. **Install scripts are skipped**: they nearly
  always build native addons, which cannot run in a browser. `.npmrc` (the
  project's, then `~/.npmrc`) sets the registry, per-scope registries
  (`@acme:registry=…`) and auth tokens (`//npm.acme.dev/:_authToken=${NPM_TOKEN}`);
  a private registry must allow CORS requests with an `Authorization` header.
* **Dev servers.** `npm run dev` running `vite`, `npm start` running
  `react-scripts start`, and Angular's `ng serve` (directly, via `npx ng serve`
  or a script; `--port` honoured) hand off to the built-in preview: they print its
  URL, fire `onServerListening` and run until Ctrl-C. The preview serves the
  directory the command ran in, so a frontend in `/web` beside an `/api` is
  served from `/web`. (Real Vite needs esbuild's native binary.)
* **Ingress.** An application whose spec (or `builderforce.json`) declares
  `ingress.routes` (`{ path: '/api', serviceId: 'api' }`, longest prefix wins,
  `/` the catch-all) gets them applied by the preview service worker: a
  frontend's relative `fetch('/api/items')`, `<img src>`, form or `EventSource`
  reaches the routed service's port. The table goes host → worker on the
  attached port only, never from a preview; each request acts as the page's
  own service (or the frontend), so it passes only along a declared
  `dependsOn` edge. Absolute `http://localhost:<port>/…` URLs in preview pages
  (`fetch`, XHR, `EventSource`) are mapped to that port's preview path too.
* **pnpm and yarn.** `pnpm install|add|remove|run|dlx|<script>` and
  `yarn [install]|add|remove|run|dlx|<script>` drive the same installer and script
  runner as npm (`-D`/`--dev` saves to devDependencies), so a README's commands
  work as written. The tree is npm-style; `pnpm-lock.yaml` and `yarn.lock` are not read.
* **Shell (`bfsh`).** Line editing, history, Tab completion, Ctrl-C/Ctrl-D; quotes,
  `$VAR`, `$(…)`, globs, `&&`/`||`/`;`/`&`, pipes and redirects; `if`/`elif`/`else`,
  `while`/`until`, `for`, `case`, functions with `local` and `return`, `{ …; }` and
  `( … )`, here-documents (`<<EOF`, `<<-EOF`, `<<'EOF'`), `test`/`[ … ]`, `read`,
  `shift`, `break`/`continue`, `jobs` and `wait`; `cd`, `ls -la`, `cat`,
  `mkdir -p`, `rm -rf`, `cp -r`, `mv`, `grep`, `head`, `tail` and friends.
  Unknown commands print `command not found`. Pipelines fail when any stage
  fails (`pipefail` is on); `set +o pipefail` — or `bfsh +o pipefail -c …` —
  gives the POSIX last-stage status. A stage writing to a pipe whose reader has
  exited stops with SIGPIPE (status 141), so `yes | head -1` ends.
* **Processes talking to each other.** `child_process.fork()` opens a message
  channel (`child.send` ↔ `process.on('message')`, `disconnect`), and
  `worker_threads` Workers run as processes of their own — in the browser, their
  own Web Worker, so in parallel — with `workerData`, `parentPort` and a worker's
  uncaught error arriving as the parent's `'error'` event. Messages are copied
  (there is no shared memory without cross-origin isolation). Pipes carry bytes
  untouched (esbuild's service protocol runs over a child's stdin/stdout), a
  child's stdio can be inherited per stream, `fs.read(0, …)` reads stdin, and
  children die with their parent unless `detached`.

Not supported yet (see the [ROADMAP](ROADMAP.md)): native addons,
`execSync`/`spawnSync`, WebSocket clients inside Node programs (the `ws` client,
Node's global `WebSocket`), and the Nuxt dev server. Outside the browser
(tests, a CLI), the core's `Kernel` runs the same programs in-process:
`new Kernel({ programs: defaultPrograms() }).run('npm', ['install'])`, with
`kernel.requestStream()` for a streamed response and
`connectWebSocket((req) => kernel.upgrade(3000, req), { path: '/' })` for a socket.

### Files, snapshots and the preview channel

```ts
// Write into a folder, move things, list a directory with kinds.
runtime.writeTree({ 'App.tsx': '…', components: { 'Button.tsx': '…' } }, '/src');
runtime.fs.rename('/src/components', '/src/ui');
runtime.fs.entries('/src'); // [{ name: 'App.tsx', kind: 'file' }, { name: 'ui', kind: 'directory' }]
runtime.fs.watch((change) => console.log(change), { under: '/src' });

// "Download project", or a full snapshot (node_modules included) to restore later.
const download = runtime.exportZip({ exclude: ['node_modules'] });
const snapshot = runtime.exportZip({ level: 1 });
runtime.importZip(snapshot); // a restored project needs no reinstall

// What the preview says, and scripts you run inside it.
runtime.onPreviewConsole(({ level, text }) => console.log(`[preview ${level}]`, text));
runtime.setPreviewScripts(['window.__TEST_HOOK__ = true;']); // or `previewScripts` at start
runtime.reload();

runtime.listProcesses(); // [{ pid, command: 'node', args: ['server.js'], cwd: '/', startedAt, ports: [3000] }]
```

Everything above addresses the project as `/`. Node programs see it where it
really lives, `runtime.root` (`/home/project` unless you pass `root`): that is
where `run` starts and what `process.cwd()` returns, with `HOME` at `/home/user`
beside it. `run`'s `cwd` and `listProcesses()`'s are project paths like the rest
(`run('npm', ['i'], { cwd: '/packages/web' })`; `..` cannot leave the project). Keeping the project below the file-system root matters to file
watchers — chokidar, under Vite and so SvelteKit, mishandles watching `/` itself.

The zip is plain zip (any unzip tool opens it). `importZip` refuses one past
250,000 entries, 256 MB per entry or 1 GB in all (a `ZipLimitError`, nothing
written); pass `limits` as its third argument to change that. To keep a snapshot across
reloads, `createSnapshotStore()` holds them in IndexedDB, keeping the most
recently used few and failing soft when storage is blocked:

```ts
const snapshots = createSnapshotStore({ maxEntries: 4 });
const key = `${projectId}:${hash(packageJson)}`;
const saved = await snapshots.load(key);
if (saved) runtime.importZip(saved); // installed packages back in a moment
else if ((await runtime.run('npm', ['install']).wait()) === 0) {
  await snapshots.save(key, runtime.exportZip({ include: ['node_modules', 'package-lock.json'], level: 1 }));
}
``` Console forwarding stops after
1,000 messages per page load, so a logging loop cannot flood the host.

### Isolating the preview (relay mode)

Served as above, the preview runs on your app's origin, so its code can read
your app's cookies and storage. That is fine for a page previewing code its own
user wrote. If the code is AI-written, or pulls in arbitrary npm packages, serve
previews from a separate origin instead:

```ts
// On https://preview.example.com, serve side by side (both exported as strings
// from '@seanhogg/builderforce-webcontainers/assets'):
//   /__bfwc/relay.html  with  Content-Security-Policy: frame-ancestors https://app.example.com
//   /__bfwc/sw.js
//   /__bfwc/process-worker.js   (only if you use run: node, npm, the shell)
const runtime = await startPreviewRuntime({ relayUrl: 'https://preview.example.com/__bfwc/relay.html' });
```

The host frames `relay.html` hidden; it registers the worker on the preview
origin and relays ports and reloads. Processes started with `run` run there
too: the relay starts each process worker from `process-worker.js` on the preview
origin, so npm packages and the user's own server never share your app's
storage or session. `frame-ancestors` is what stops other sites from driving
your relay, so always set it. A relay on your page's own origin is refused.

#### One origin per application (`previewOrigin`)

One preview origin keeps previews away from your app, but not from each other:
every application started with `startApplicationRuntime` shares its storage,
Cache Storage, BroadcastChannels and service worker. Give each application its
own origin:

```ts
import { previewOriginTemplate, startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

const runtime = await startPreviewRuntime({
  id: projectId, // keys every application's origin: pass a stable, unique project id
  relayUrl: 'https://preview.example.com/__bfwc/relay.html',
  previewOrigin: previewOriginTemplate('https://{key}.preview.example.com'),
  previewEgress: (applicationId) => (applicationId ? declaredApis(applicationId) : []),
  workerPolicy: (applicationId) => signedPolicyId(applicationId),
  security: { sink: { emit: (event) => report(event.reasonCode, event) } },
});
```

`{key}` is 32 lowercase hex characters: the first 128 bits of SHA-256 over
(runtime `id`, application id), so it is unique per project and application
across a browser profile and never a raw, user-controlled name
(`previewOriginKey(id, applicationId)` computes it). An application's first
process opens a hidden relay at `https://<key>.preview.example.com` plus
`relayUrl`'s path; its processes run there and its servers' URLs point there.
The page serves an application's ports only through its own origin (and the
workspace's only through `relayUrl`'s): any other request is a 403
(`ingress.app_origin_mismatch`). An origin that is not a bare https origin, or
that equals your page's, `relayUrl`'s or another application's, refuses the
application's process (`ingress.preview_origin_invalid`). Without
`previewOrigin`, an application's first process is refused the same way, unless
you opt out by name with `sharedPreviewOrigin: 'unprotected'` — then
applications share `relayUrl`'s origin, and the runtime warns once per page and
reports `ingress.shared_preview_origin`.

Deployment: a wildcard DNS record (`*.preview.example.com`) and a wildcard TLS
certificate, and a host route that serves the same files on every
`<key>.preview.example.com` as on `preview.example.com` — `relay.html` (with
`frame-ancestors` limited to your app), `sw.js` and the process worker scripts —
at the same path.

On a zone whose certificate covers one level only (e.g. Cloudflare Universal SSL's
`*.example.com`), use a single-label template instead —
`previewOriginTemplate('https://{key}-preview.example.com')` — so the existing
`*.example.com` wildcard DNS record and certificate cover every application. The
origins are still distinct (storage, DOM, service workers), but they are same-site
with `example.com`, so the Public Suffix List cannot separate their cookies.

Every preview document the service worker routes gets a Content-Security-Policy
of `connect-src 'self' blob: data: <previewEgress>; worker-src 'self' blob:`,
added beside (never replacing) any the app sets, so it can only tighten. Process
Worker scripts are requested with `?policy=<workerPolicy>` (an opaque id you sign;
`[A-Za-z0-9._~-]`, at most 512 characters); workspace processes and spares made
before an application is known carry none — serve those the most restrictive
policy. Every attach of a preview to the service worker carries a fresh nonce
chained to the previous one, so a page that can post as the relay but never saw
the host's messages cannot rebind a preview (`ingress.attach_rejected`).

#### Security events (`security.sink`)

Every refusal the runtime makes on the page side — a port the service graph
does not allow, a database login or name refused, a write outside an
application's directory, a spawn over quota, a request body over 32 MiB (also on
in-runtime loopback HTTP and `runtime.request`, answered 413), an origin
mismatch — becomes one `SecurityEvent` (`@seanhogg/builderforce-webcontainers/security`):
`{ category, ruleId, severity, reasonCode, action, context, evidence, occurredAt }`.
`context` is who the runtime assigned the actor at spawn, never what a process
claims; `evidence` is redacted (no passwords, tokens, cookies or bodies) and at
most 4 KB. Events go to `security.sink` (called synchronously, never awaited; a
throwing sink is ignored) and into a bounded ring: `runtime.security().events()`
and `runtime.security().health()` (`enforcement` and `telemetry`, reported
separately).

A dev-server handoff (`vite`, `ng serve`) acts as an application's frontend on the
shared preview origin only when the announcing process is that application's
frontend service (the `/` ingress route's service, else its single frontend-role
service) and the handoff serves neither the whole project nor a directory holding
another application. While one application's handoff is live, another
application's is refused and reported (`ingress.handoff_conflict`): the first
keeps the shared preview until it ends.

## Assets fetched at runtime

The runtime downloads some of what it runs on first use instead of shipping it.
This matters when your page has a strict CSP or no network access. The table
lists every origin the runtime itself fetches from by default. It does not
include what a previewed app or a user's program fetches on its own. Versions
are pinned in the source; the constant is named where there is one.

Where the fetch happens decides which policy has to allow it:

- **Preview page:** the preview CSP, so the origin must be in `previewEgress`
  (see [Upgrading to 2026.11.5](#upgrading-to-2026115)). The default esm.sh is
  added for you.
- **Host page / host-origin Worker:** your own page's CSP.
- **Process Worker:** in relay mode, the Worker runs on the preview origin under
  the process Worker script CSP. That CSP is `workerScriptCsp`, whose
  `DEFAULT_CONNECT_SOURCES` already lists every default origin below except the
  .NET bundle; see [Preview origin headers](packages/browser/README.md#preview-origin-headers).
  In same-origin mode, the Worker runs on your page's origin under your page's
  CSP.

| What | Default origin | Fetched by | When | Self-host / override |
|---|---|---|---|---|
| npm packages as ES modules, including the React Fast Refresh runtime and `@angular/compiler`, plus each declared package's `package.json` | `https://esm.sh` | The preview page loads the modules. The host page fetches the manifests. | On the first import of each package. Built sites (`runtime.build()`) keep loading packages from it too. | `cdn` (a `PackageCdnFactory`; `cdn: createEsmShCdnFactory({ origin })` for an esm.sh-compatible mirror, whose origin then joins the preview egress, so your `sw.js` gate must grant it) |
| esbuild's WebAssembly binary | `https://cdn.jsdelivr.net/npm/esbuild-wasm@<installed version>/esbuild.wasm` | Host page | `startPreviewRuntime` (the default compiler) | `transformer: await createEsbuildWasmTransformer({ wasmURL })`. The first initialisation wins, and `build()`'s bundler shares it. |
| Vue SFC compiler | `https://cdn.jsdelivr.net/npm/@vue/compiler-sfc@<range>/…` | Host page | The first `.vue` file | `components: createCdnComponentCompilers({ vueCompilerUrl })` |
| Svelte compiler | `https://esm.sh/svelte@<range>/compiler` | Host page | The first `.svelte` file | `components: createCdnComponentCompilers({ svelteCompilerUrl })` |
| Sass and Less | `https://esm.sh/sass@<range>`, `https://esm.sh/less@<range>` | Host page | The first `.scss`/`.sass`/`.less` file or `<style lang>` block | `styles: createCdnStyleCompilers({ sassUrl, lessUrl })` |
| Package stylesheets for Sass/Less `@use`/`@import` | `https://cdn.jsdelivr.net/npm/<name>@<range>/…` | Host page | Only when the package is not in the project's `node_modules` | `styleImports.packageFileUrl` on the core `DevServer`/`buildProject`. `startPreviewRuntime` does not expose it. |
| Type-checking (`createChecker`): the TypeScript compiler, its `lib.*.d.ts` files, tsconfig `extends` packages, and dependency types (esm.sh's `X-TypeScript-Types`) | `https://cdn.jsdelivr.net/npm` (`typescript@TYPESCRIPT_VERSION`), `https://esm.sh` | Checker Worker (host origin) | The first check | `createChecker({ typescriptUrl, sources: { libBaseUrl, npmBaseUrl, typesOrigin } })` |
| npm registry: metadata and tarballs | `https://registry.npmjs.org` | Node process Worker | `npm`/`pnpm`/`yarn install` | `node.registry`; `.npmrc` scoped registries |
| PGlite (Postgres) | `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@PGLITE_VERSION/dist/index.js` and its WebAssembly beside it | Database Worker (host origin) | When the first `pglite` database service starts | `createPgliteProvider(runtime, { pgliteUrl })` |
| Pyodide and its packages | `https://cdn.jsdelivr.net/pyodide/vPYODIDE_VERSION/full/` | Python process Worker | The first `python` process | `python.pyodideIndexURL` |
| PyPI (micropip) | `https://pypi.org`, `https://files.pythonhosted.org` | Python process Worker | `pip install` and requirements that Pyodide does not carry | `pip install -i`/`--index-url`/`--extra-index-url`, or `PIP_INDEX_URL`/`PIP_EXTRA_INDEX_URL` in the process environment |
| php-wasm | `https://cdn.jsdelivr.net/npm/` (`@php-wasm/universal`, `@php-wasm/web-8-x` at `PHP_WASM_VERSION`) | PHP process Worker | The first `php` process | `php.baseUrl` (a jsDelivr-style npm layout; `phpWasmModuleUrls` lists the files to mirror) |
| Composer metadata | `https://packagist.org/packages/<name>.json` | PHP process Worker | `composer install`/`require`/`update` | `php.composer.repositoryUrl` (a `{name}` template; a `p2` mirror works) |
| Composer package files | The dist URL in the metadata (GitHub zipballs for most packages). Browsers can't fetch those, so the fallback is `https://cdn.jsdelivr.net/gh/` with `https://data.jsdelivr.com/v1/packages/gh/` for listings. | PHP process Worker | `composer install`/`require`/`update` | `php.composer.distProxy` (a CORS proxy prefix) |
| .NET runtime bundle | None | .NET process Worker | The first `dotnet` process | `dotnet.bundleUrl`: serve `@seanhogg/builderforce-webcontainers-dotnet` ([.NET](packages/browser/README.md#net)) |

The Rust runtime runs prebuilt modules and fetches nothing. `dotnet restore`
only checks references against the bundled packages and fetches nothing from
NuGet. The NuGet hosts in `DEFAULT_CONNECT_SOURCES` are allow-listed, but this
release never contacts them.

## How it works

```
 host page                                    service worker (/__bfwc/sw.js)
 ┌──────────────────────────────┐            ┌─────────────────────────────┐
 │ VirtualFileSystem            │  MessagePort│ GET /__bfwc/<id>/src/App.tsx│
 │ DevServer ── esbuild-wasm    │◀───────────▶│  → forwarded to the page    │
 │   resolve · rewrite imports  │            │ everything else: untouched  │
 └──────────────────────────────┘            └─────────────────────────────┘
          ▲ iframe src = /__bfwc/<id>/              │ react, lodash … → esm.sh
```

* **No bundling.** Each file is compiled on request and served as a native ES
  module, the way Vite's dev server works, so startup is immediate and an edit
  recompiles one file.
* **Packages from a CDN.** Bare imports become esm.sh URLs, version-pinned from
  `package.json`, with shared dependencies deduped (one React).
* **Stateless worker.** Browsers kill idle service workers; when that happens the
  worker asks open pages to re-attach instead of failing the request.

## Attribution

Every preview shows a small **"Built with Builderforce.ai"** badge in its
bottom-right corner. It sits in a shadow root, so it never collides with the app's
styles, and it follows the system light/dark theme.

It is on by default and **not** a licence condition: the project is MIT. The
supported way to turn it off is the host option
`startPreviewRuntime({ ..., attribution: false })`. If this runtime saves you
money, please leave it on. That link is how the project is funded.

The shell also has a `bfwc-badge off|on|status` command. It is an internal
maintainer toggle, not an API, and `help`, `type`, `which` and tab completion
don't show it. It works through a marker file, `/.bfwc/attribution-off`, in the
runtime's file system. The host checks for the file on each page it serves, so
a change applies on the next reload. Any process in the project can create or
delete that file. `attribution: false` always wins over the marker. Don't build
on the command.

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

## Licence

MIT © Sean Hogg
