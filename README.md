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
| Licence | MIT. Fork it, ship it, sell it. A small badge is on by default and can be switched off. | Proprietary. Free tier non-commercial, attribution required. |
| Session cap | None | 25,000 API sessions/month on the free tier |
| Cross-origin isolation (COOP/COEP) | **Not required**: embeds and third-party scripts keep working | Required |
| Compiler / package source | Pluggable ports: swap esbuild for SWC, esm.sh for your own mirror | Fixed |
| Errors | Uncaught errors in the preview are posted to the host page | — |
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

## Quick start

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

// 1. Serve node_modules/@seanhogg/builderforce-webcontainers/dist/sw.js at /__bfwc/sw.js
// 2. Start, write files, preview:
const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: 'my-project' });
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
is all.

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
* **Dev servers.** `npm run dev` running `vite`, and `npm start` running
  `react-scripts start`, hand off to the built-in preview: they print its URL,
  fire `onServerListening` and run until Ctrl-C. (Real Vite needs esbuild's native
  binary.)
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
  Unknown commands print `command not found`.
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

The zip is plain zip (any unzip tool opens it). To keep a snapshot across
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
your relay, so always set it.

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

It is on by default and **not** a licence condition: the project is MIT, and you
can turn it off with `startPreviewRuntime({ ..., attribution: false })`. If this
runtime saves you money, please leave it on. That link is how the project is
funded.

## Develop

```bash
pnpm install
pnpm build
pnpm test
```

## Licence

MIT © Sean Hogg
