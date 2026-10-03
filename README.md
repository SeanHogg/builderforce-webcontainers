# BuilderForce WebContainers

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
| Node.js servers, `npm install`, shell | Not yet (see [ROADMAP](ROADMAP.md)) | Yes |

Today it runs **frontend apps**: Vite (React, Vue, Svelte) and Create React App
projects, and static sites. It previews them, builds them for deployment, and
type-checks them. Frameworks that need a Node server (Next.js, Nuxt, SvelteKit,
Remix, Astro) are detected and declined with a reason, so a host can fall back to
another runtime instead of showing a broken preview. The roadmap is how it closes
the rest of the gap.

## Quick start

```ts
import { bootPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

// 1. Serve node_modules/@seanhogg/builderforce-webcontainers/dist/sw.js at /__bfwc/sw.js
// 2. Boot, mount, preview:
const runtime = await bootPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: 'my-project' });
runtime.mount({
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
`bootPreviewRuntime` to supply compilers yourself. Not yet: `<style lang="scss">`
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
const runtime = await bootPreviewRuntime({ relayUrl: 'https://preview.example.com/__bfwc/relay.html' });
```

The host frames `relay.html` hidden; it registers the worker on the preview
origin and relays ports and reloads. `frame-ancestors` is what stops other sites
from driving your relay, so always set it.

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
can turn it off with `bootPreviewRuntime({ ..., attribution: false })`. If this
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
