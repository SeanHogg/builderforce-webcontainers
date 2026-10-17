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
Express-style servers, and an interactive shell for a terminal. Frameworks whose
dev servers need native binaries (Next.js, Nuxt, SvelteKit, Remix, Astro) are
detected and declined with a reason, so a host can fall back to
another runtime instead of showing a broken preview. The roadmap is how it closes
the rest of the gap.

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

// Edits reload every open preview of this project; nothing to restart.
runtime.fs.writeFile('/src/main.tsx', '...');
```

Requirements: a secure context (https or localhost) for the service worker. That
is all.

### Vue and Svelte

`.vue` and `.svelte` files work with no setup. The first time a project needs one,
the runtime loads the official compiler from a CDN (`@vue/compiler-sfc`'s browser
build from jsDelivr, `svelte/compiler` from esm.sh), pinned to the project's own
`vue` / `svelte` range so compiler and runtime agree. Vue `<style scoped>` and
Svelte's component CSS are scoped as usual. Pass `components` to
`startPreviewRuntime` to supply compilers yourself. Not yet: `<style lang="scss">`
and other preprocessors, and TypeScript in Svelte 4 (Svelte 5 handles it).

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
* **Shell (`bfsh`).** Line editing, history, Tab completion, Ctrl-C/Ctrl-D; quotes,
  `$VAR`, `$(…)`, globs, `&&`/`||`/`;`/`&`, pipes and redirects; `cd`, `ls -la`,
  `cat`, `mkdir -p`, `rm -rf`, `cp -r`, `mv`, `grep`, `head`, `tail` and friends.
  Unknown commands print `command not found`.

Not supported yet (see the [ROADMAP](ROADMAP.md)): native addons, streaming
responses and WebSockets, `execSync`/`spawnSync`, cookies set by a virtual server,
and the Next.js/Nuxt dev servers. Outside the browser (tests, a CLI), the core's
`Kernel` runs the same programs in-process:
`new Kernel({ programs: defaultPrograms() }).run('npm', ['install'])`.

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

The zip is plain zip (any unzip tool opens it). The host decides where a
snapshot lives (IndexedDB, OPFS, your server). Console forwarding stops after
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
