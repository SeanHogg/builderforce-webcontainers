# @seanhogg/builderforce-webcontainers

The browser runtime of
[BuilderForce WebContainers](https://github.com/SeanHogg/builderforce-webcontainers):
boot an in-browser dev server and preview the project in an iframe. No COOP/COEP
headers, no session caps, MIT licensed.

1. Serve `dist/sw.js` from your site, ideally at `/__bfwc/sw.js` so the worker's
   scope stays off the rest of your app. You can resolve its path with
   `import.meta.resolve('@seanhogg/builderforce-webcontainers/sw.js')`, or copy it
   in your build.
2. Start and write the files:

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId });
runtime.writeTree(files);
if (runtime.profile().supported) iframe.src = runtime.url;
else showFallback(runtime.profile().reason);
```

To run untrusted code (AI-written, arbitrary packages), isolate the preview on its
own origin with `startPreviewRuntime({ relayUrl })`. That origin serves
`relay.html`, `sw.js` and `process-worker.js` (strings in `@seanhogg/builderforce-webcontainers/assets`)
with `Content-Security-Policy: frame-ancestors` limited to your app. See the
[root README](../../README.md#isolating-the-preview-relay-mode).

`runtime.build({ base })` returns a deployable static site (`{ files: [{ path, data }] }`),
and `createChecker()` from `@seanhogg/builderforce-webcontainers/check` type-checks
the project in a Web Worker. `.vue` and `.svelte` files need no setup. See the
[root README](../../README.md#building-for-deployment).

The package re-exports everything from
[`@seanhogg/builderforce-webcontainers-core`](../core).

## Angular

Angular 17–20 (the supported majors) projects made by `ng new` (standalone components) run in the
instant preview and build with `runtime.build()` unchanged, in JIT mode: the
runtime does at load time what the Angular CLI does at build time, and
`@angular/compiler` compiles templates in the page.

Supported:

- `angular.json` build options: `browser` / `main`, `index`, `polyfills`,
  global `styles` (`.css`, `.scss`, `.sass`, `.less`; `inject: false` entries are
  skipped; a package stylesheet such as
  `@angular/material/prebuilt-themes/azure-blue.css` or
  `node_modules/bootstrap/dist/css/bootstrap.min.css` is loaded from the package
  CDN) and `assets` (string paths and `{ glob, input, output }` objects).
  Every other option (`aot`, `optimization`, `budgets`, `ssr`, `prerender`,
  `i18n`, …) is ignored. Without `angular.json`, `src/index.html` and
  `src/main.ts` are used.
- `templateUrl`, `styleUrl` and `styleUrls`, including Sass and Less.
- Constructor injection (with `@Inject`, `@Optional`, `@Self`, `@SkipSelf`,
  `@Host`, `@Attribute`, imported from `@angular/core` under any alias) and
  `inject()`. Parameter types map as Angular's own compiler maps them:
  `T | null` → `T`, `string`/`number`/`boolean` → `String`/`Number`/`Boolean`,
  function types → `Function`, arrays and tuples → `Array`, a class → itself.
  Any other type (an interface, a union, a type-only import) becomes `undefined`;
  Angular then reports NG0202 only if that parameter is actually injected without
  `@Inject(TOKEN)`.
- Signal `input()` / `model()` / `output()` / `outputFromObservable()` and the
  signal queries (`viewChild`, `viewChildren`, `contentChild`, `contentChildren`),
  when imported from `@angular/core` (aliases and `import * as ng` included); a
  function of your own named `input` is left alone.
- Errors Angular only logs — a failed `bootstrapApplication(...).catch(console.error)`,
  its ErrorHandler, template checks such as NG0303 — reach `runtime.onError` with
  `source: 'console'` and their `code`. This console forwarding is on for Angular
  apps only; in other apps `console.error` is console output.
- `ngDevMode` is defined `false` in `runtime.build()` output.
- zone.js apps (async/await in your code is lowered so zone.js can track it)
  and zoneless apps (`provideZonelessChangeDetection()`, no `zone.js` dependency).
- One Angular version: every `@angular/*` framework package loads at the
  `@angular/core` range, and the commonly imported ones are pinned even when
  `package.json` does not list them.

Limits: no AOT, no SSR or prerendering, no CLI builders or `ng` commands, no
schematics (`ng add @angular/material` and friends). NgModule-bootstrapped apps
are untested and best-effort. async/await inside packages loaded from the CDN
stays native, so zone.js does not see it. An asset glob other than "everything"
(`**/*`) copies the whole input folder. An `@angular/core` range outside 17–20
is refused; a range naming no major (`latest`, `next`, `*`) is not checked, so
pin a supported major. An Analog project runs in the Node runtime (it needs its
Vite pipeline); an `@angular/core` app without the CLI layout (its own
`index.html`) gets the same preludes on its page entry.

```text
angular.json
package.json          @angular/core, @angular/common, @angular/platform-browser, zone.js, …
tsconfig.json
public/favicon.ico
src/index.html        <base href="/"> … <app-root></app-root>
src/main.ts           bootstrapApplication(App, appConfig)
src/styles.scss
src/app/app.config.ts
src/app/app.ts        @Component({ selector: 'app-root', templateUrl: './app.html', styleUrl: './app.scss' })
src/app/app.html
src/app/app.scss
```

```ts
const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId });
runtime.writeTree(files); // the tree above
runtime.profile(); // { supported: true, kind: 'angular', framework: 'angular', entry: '/src/main.ts', … }
iframe.src = runtime.url;
```

## The `./ml` subpath

The in-browser ML runtime lives on its own subpath so the root stays the dev
runtime only: local inference (`createInferenceClient`, backends, the IndexedDB
`createModelCache`), the adaptive execution controller, memory residency, the
knowledge/retrieval layer, prefetch, KV-cache optimisation and online learning.

```ts
import { createInferenceClient, createModelCache } from '@seanhogg/builderforce-webcontainers/ml';

const client = createInferenceClient({
  // Optional: adopt an existing weights database instead of `bfwc-inference-models`.
  cache: createModelCache({ dbName: 'my-weights', storeName: 'weights', dbVersion: 1 }),
});
await client.load({ id: 'tiny-q4', paramsB: 1.1, quantization: 'q4', source: { kind: 'url', url: modelUrl } });
for await (const { token } of client.generate([{ role: 'user', content: 'hi' }], { signal })) render(token);
```

The client starts the self-contained worker bundle that ships beside it. If your
bundler does not copy it, serve `@seanhogg/builderforce-webcontainers/ml/worker.js`
yourself and pass `createWorker: () => new Worker(url)`.

## Applications (the `./app` subpath)

`startApplicationRuntime` runs several services (a frontend, an API, a one-off
migration) as one application on top of a preview runtime. You describe them in
a plain `ApplicationSpec`:

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';
import { startApplicationRuntime, createNodeProvider } from '@seanhogg/builderforce-webcontainers/app';

const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId });
runtime.writeTree(files);

const app = startApplicationRuntime(
  {
    projectId,
    services: [
      { id: 'api', type: 'application', runtime: 'node', root: '/api', command: 'node', args: ['server.js'],
        port: 8000, readiness: { kind: 'http', path: '/health' }, restartPolicy: 'on-failure' },
      { id: 'web', type: 'application', runtime: 'node', role: 'frontend', root: '/web', command: 'npm', args: ['run', 'dev'],
        port: 3000, dependsOn: ['api'] },
    ],
  },
  { providers: [createNodeProvider(runtime)] },
);
app.onStateChange(({ serviceId, to }) => console.log(serviceId, to));
await app.start();            // api first; web once api's /health answers
iframe.src = app.getUrl('web')!;
```

- **Order.** A service starts once everything in its `dependsOn` is ready.
  `stop()` stops dependents first: `SIGTERM`, then `SIGKILL` after `stopTimeoutMs`.
- **Readiness.** `port` (the port opens; the default with a port), `http` (a
  health path answers 2xx/3xx over the runtime's own localhost), `exit-zero` (the
  default without a port: a one-off command finished). `query` is for databases.
- **Restart policy.** `never`, `on-failure` (the default) or `always`, with
  backoff and a limit (`restart: { maxRestarts, backoffMs }`). A failed service
  never stops the others; a running frontend keeps running while its API restarts.
- **Environment.** Every service gets `<ID>_URL=http://localhost:<port>` for each
  application service (`API_URL` for `api`), `PORT`, `BUILDERFORCE_SERVICE` and
  `BUILDERFORCE_PROJECT_ID`. A backend gets `<DB>_DATABASE_URL` for each database
  it depends on, and `DATABASE_URL` only when it depends on exactly one. A
  `frontend` never gets database credentials: not generated ones, and not
  `DATABASE_URL`-like entries of the app-wide `env` (only its own `env` can opt in).
- **Logs.** `app.logs()` is a `ReadableStream` of lines from every service
  (`app.logs('api')` for one), history first, then live. A reader that falls
  `logReaderBuffer` entries behind loses the overflow and gets a line saying how
  many. Streams stay open across `stop()`/`start()`; `app.dispose()` stops the
  app and ends them (so `for await` loops finish).
- **Errors.** `start()` rejects with `ApplicationStartError` naming the services
  that failed for good; `onError` reports every failure as it happens, with
  whether it will restart. A service stopped before it was ready is not a
  failure. `restart(id)` leaves dependents running; a dependent still waiting
  for the restarted service keeps waiting.

Runtimes plug in as `RuntimeProvider`s (`{ id, accepts(service), start(service, ctx) }`).
`start()` first checks that every service has a provider that accepts it (the
`node` provider declines databases, `wrangler dev` and Docker). If any is
declined, nothing starts and `start()` rejects with the reasons (phase
`declined`) — never a half-started app. `validateSpec`, `serviceGraph`,
`serviceEnv` and the lifecycle state machine are exported too, as pure functions.
