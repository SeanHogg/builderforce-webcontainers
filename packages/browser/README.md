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

### Databases (PGlite)

A `database` service with `runtime: 'pglite'` runs Postgres (PGlite) in its own
Worker, behind a Postgres wire gateway on the service's port. Services reach it
with an unmodified driver (`pg`, `postgres`, Drizzle, Prisma driver adapters) at
`DATABASE_URL=postgres://postgres@localhost:<port>/postgres`:

```ts
import { createNodeProvider, createPgliteProvider, startApplicationRuntime } from '@seanhogg/builderforce-webcontainers/app';

const app = startApplicationRuntime(
  {
    projectId,
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' },
        database: { engine: 'postgres', provider: 'pglite', persistent: true } },
      { id: 'api', type: 'application', runtime: 'node', root: '/api', command: 'node', args: ['server.js'],
        port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
    ],
  },
  { providers: [createNodeProvider(runtime), createPgliteProvider(runtime)] },
);
await app.start();                          // db ready once SELECT 1 succeeds, then api
const backup = await app.database('db').export();   // a data-directory tarball (Blob)
await app.database('db').import(backup);            // or .reset() to empty
```

- **Storage.** `persistent: true` keeps the data in IndexedDB, one store per
  project and database id (`pgliteDataDir`), outside the project files: it
  survives reloads and never lands in `exportZip`. `persistent: false` is in memory.
- **Lifetime.** The database outlives restarts of the services using it and
  closes (flushed) with the application. A stop (`SIGTERM`) hangs up its
  clients, flushes and closes PGlite, and terminates the Worker if that takes
  longer than `closeTimeoutMs` (5 s); `SIGKILL` terminates it at once.
  `import`/`reset` close its open connections; pools reconnect. An `import` is
  opened and checked in a scratch in-memory PGlite first: a corrupt snapshot is
  refused and the current data stays.
- **Connections.** Any number of clients; they share PGlite's single session,
  taking turns. A client keeps the engine until a reply says its session is idle
  again — through `BEGIN … COMMIT`, through an extended-protocol exchange up to
  its `Sync`, through `COPY` — so no other client's statement lands inside it.
  A client that disconnects mid-transaction is rolled back. One that holds the
  engine and goes quiet for `idleInTransactionTimeoutMs` (30 s; 0 = never) is
  rolled back and disconnected with `FATAL 25P03`, as Postgres's
  `idle_in_transaction_session_timeout` does.
- **Deadlock to avoid.** Because there is one session, a client that waits,
  inside its own transaction, on ANOTHER connection — `await pool.query(…)`
  while holding a `pool.connect()` client in `BEGIN` — waits for itself: the
  second connection's turn comes only after the first commits. Run every
  statement of a transaction on the transaction's client. The idle timeout ends
  such a deadlock by rolling the transaction back.
- **Limits of the shared session.** `SET`, named prepared statements, temp
  tables and `LISTEN` are visible to every connection; query cancellation is not
  supported; the gateway trusts every connection (no password) and serves no TLS
  (`sslmode=disable`). A protocol violation (bad or oversized packet, HTTP sent
  to the port) gets `FATAL 08P01` and a hang-up.
- **Backpressure.** The gateway credits a client's bytes as it runs them (past a
  256 KB queue) and runs a client's next batch only once it has read its replies
  to within 256 KB, so neither a flooding writer nor a slow reader piles up memory.
- **Isolation.** The database Worker always runs on the HOST origin
  (`runtime.createDatabaseWorker()`), relay mode included: the code a project
  runs lives on the preview origin and has no path to the database's IndexedDB
  storage; only gateway bytes cross between its processes and the database.
  Preview pages reach services over HTTP only, never the database port.
  `runtime.dispose()` terminates database Workers still running.
- **Tabs.** The origin's tabs share one database: the tab holding its Web Lock
  runs it, and every other tab proxies its clients to that tab over a
  BroadcastChannel and waits in line. When the owner closes it (or its tab
  dies), the next tab takes over from IndexedDB; clients connected through other
  tabs see their connection close, and reconnect. Persistent databases need Web
  Locks (`navigator.locks`): without it they are refused with
  `DatabaseCoordinationError` rather than risk two owners writing the same files
  (a BroadcastChannel claim cannot tell a frozen tab from a gone one).
- **PGlite itself** is imported by the database Worker at run time from
  `pgliteUrl` (default: the pinned build on jsDelivr, `DEFAULT_PGLITE_URL`), so
  neither the page nor the process Worker bundle carries Postgres.

### Virtual TCP (`net`)

Processes talk raw TCP to each other on localhost: `net.createServer().listen(port)`
takes connections and `net.connect(port)` / `new net.Socket().connect()` reach a
listener in any process of the runtime (or on the page: `runtime.listenTcp`,
`runtime.connect`). `'connect'`, `'data'`, `'end'`, `'close'`, `ECONNREFUSED` when
nothing listens, write callbacks, corked writes leaving as one send
(`_writev`), and backpressure (`write()` returns false, then `'drain'`) behave
as in Node. Flow control is credit-based: a page-side listener that never
credits what it reads (`runtime.listenTcp`'s `accept`) is credited
automatically on delivery, so it cannot stall a writer; one that wants to push
back calls `socket.manualFlowControl()` and credits with `socket.consumed(n)`.
Bytes travel over postMessage, never
SharedArrayBuffer. Hosts other than localhost are refused, never dialled on the
network. Not modelled: half-open connections (`end()` closes both directions),
and HTTP over a raw connection to an HTTP-only port (it connects, then closes).

### Python

Python commands run in a Python process Worker — CPython on WebAssembly
([Pyodide](https://pyodide.org) `314.0.7`, loaded from jsDelivr when a process
starts, or from `python.pyodideIndexURL`) — beside the Node processes, on
the same files and ports. `runtime.run('python', ['app.py'])`, a shell's
`python app.py`, Node's `spawn('python')` and a script whose shebang names
Python (`./manage.py`) all work. A `python` service uses
`createPythonProvider(runtime)`:

```ts
import { createPgliteProvider, createPythonProvider, startApplicationRuntime } from '@seanhogg/builderforce-webcontainers/app';

const app = startApplicationRuntime(
  {
    projectId,
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' },
        database: { engine: 'postgres', provider: 'pglite', persistent: true } },
      { id: 'api', type: 'application', runtime: 'python', root: '/api', command: 'uvicorn',
        args: ['main:app', '--port', '8000'], port: 8000, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } },
    ],
  },
  { providers: [createPythonProvider(runtime, { fs: runtime.fs }), createPgliteProvider(runtime)] },
);
```

- **Commands.** `python script.py | -c code | -m module`, `pip install`
  (packages, `-r` files, `-i`/`--extra-index-url`, `PIP_INDEX_URL`, `pip install .`
  for a project's own dependencies), and app servers read as declarations:
  `uvicorn module:app [--port --app-dir --factory --interface wsgi]`,
  `gunicorn [-k uvicorn.workers.UvicornWorker] module:app -b :port`, `hypercorn`,
  `waitress-serve`, `flask [--app] run [-p]`, `fastapi run|dev [file]`. Port:
  the option, else `PORT`, else the server's default. Interactive Python (no
  script) is declined: there is no terminal.
- **Packages (micropip).** Before a program runs, the project's
  `requirements.txt` (with `-r` includes; hashes and per-line options ignored)
  or `pyproject.toml` (`[project] dependencies`, Poetry) is installed, plus
  whatever `pip install` added earlier in the session (the process host's
  record: each earlier install is repeated with only the indexes it used, never
  applied to the project's requirements; one that cannot be repeated is a
  warning). Pyodide-built packages come from Pyodide's index, pure-Python wheels
  from PyPI (or `PIP_INDEX_URL`). Packages that cannot work in the browser are declined **by name**
  with a reason — known ones (`psycopg2`, `asyncpg`, `psutil`, `uvloop`,
  `grpcio`, `torch`, …) before anything downloads, the rest when no usable wheel
  exists; a declined dependency of another package is mocked so the rest
  installs. App servers (`uvicorn`, `gunicorn`, …) are provided by the runtime,
  never installed. The `python` provider declines a service whose requirements
  hold a native-only package up front, so the host can choose another target.
- **ASGI / WSGI, request-driven.** The runtime imports the app and calls it per
  request on the service's virtual port: ASGI 3 (http scope, streamed body with
  backpressure, `http.disconnect` when the reader hangs up, the lifespan
  protocol when the app speaks it) and WSGI. `uvicorn.run(app)` in `__main__`
  serves the same way. An app exception is a 500 carrying the traceback.
  FastAPI's sync endpoints and `asyncio.to_thread` run inline (Pyodide has no
  threads; `anyio.from_thread` raises rather than deadlock).
- **Sockets.** Python's `socket.create_connection`, `socket.socket(...).connect`
  and `bfwc.vsocket.open_connection` (asyncio) reach localhost ports in any
  process — the PGlite gateway too, so an unmodified `pg8000` works with
  `DATABASE_URL`. Blocking calls wait through JSPI (`pyodide.ffi.run_sync`), no
  SharedArrayBuffer; timeouts and non-blocking mode are honoured, and a send
  waits while the peer is more than 64 KiB behind (backpressure). The runtime's
  connections have no half-close: `shutdown(SHUT_WR)` stops this side's sends,
  and the peer sees end of stream only at `close()`. Only localhost is
  reachable. Without JSPI, blocking calls raise `BlockingIOError` naming the
  asyncio API.
- **Files.** The project is mounted at `/project` in Python (`node_modules` and
  `.git` are left out), and changes flow both ways: a file is sent when it is
  closed, and while it stays open shortly after writes stop. Symlinks reach the
  page as copies. No bytecode files are written.
- **Extensions.** `python.extensions: [{ moduleUrl, exportName }]` (runtime
  options only — never a program's environment) are imported inside each
  Python Worker before the program; the export returns `{ jsModules, files,
  root, provides, imports }` — JS modules Python can import, a Python package
  written under `root` (outside `/project`; files may not leave it; first on
  `sys.path`), the distribution names it satisfies (never installed or
  declined) and their import names (default: `provides` with `-` as `_`).
- **Limits.** No WebSockets or raw-TCP servers in Python apps yet; `input()` sees
  only stdin that already arrived; a busy synchronous loop ends only when the
  kill grace period terminates its Worker; no `subprocess`.
- **Relay mode.** Python Workers run on the preview origin like Node's: serve
  `dist/python-worker.js` (`pythonWorkerSource` in `./assets`) as
  `<scope>/python-worker.js` beside `process-worker.js`. `pyodideIndexURL` and
  every extension `moduleUrl` must then be absolute URLs served with CORS
  headers that allow the preview origin (the Worker fetches and imports them
  from there; relative URLs would resolve against the preview origin).

### PHP

PHP commands run in a PHP process Worker — PHP 8.3 (8.1–8.4 with
`php.phpVersion`) on WebAssembly from
[php-wasm](https://github.com/WordPress/wordpress-playground) `3.1.62`,
loaded from jsDelivr when a process starts, or from `php.baseUrl` — beside the
Node and Python processes, on the same files and ports. `runtime.run('php',
['app.php'])`, a shell's `php …`, Node's `spawn('php')` and a script whose
shebang names PHP (`./artisan`) all work. A `php` service uses
`createPhpProvider(runtime)`:

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';
import { createPgliteProvider, createPhpProvider, startApplicationRuntime } from '@seanhogg/builderforce-webcontainers/app';

// One options object: the runtime's PHP processes and the provider's checks read the same version.
const phpOptions = { phpVersion: '8.3' };
const runtime = await startPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId, php: phpOptions });
await runtime.run('composer', ['install', '--no-dev'], { cwd: '/api' }).wait();
const app = startApplicationRuntime(
  {
    projectId,
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' },
        database: { engine: 'postgres', provider: 'pglite', persistent: true } },
      { id: 'api', type: 'application', runtime: 'php', root: '/api', command: 'php',
        args: ['-S', '0.0.0.0:8000', '-t', 'public', 'public/index.php'], port: 8000, dependsOn: ['db'],
        readiness: { kind: 'http', path: '/health' } },
    ],
  },
  { providers: [createPhpProvider(runtime, { fs: runtime.fs, php: phpOptions, platform: runtime.phpPlatform }), createPgliteProvider(runtime)] },
);
```

- **Licence.** php-wasm is GPL-2.0-or-later. This package never bundles it:
  the PHP Worker imports it at run time, by URL, from jsDelivr or the host's
  mirror (`php.baseUrl`, laid out like jsDelivr's npm CDN:
  `<base>@php-wasm/universal@3.1.62/+esm` and
  `<base>@php-wasm/web-8-3@3.1.62/jspi/php_8_3.js` with its `.wasm` beside it).
  A mirror must carry the `asyncify/` build too (same layout, `asyncify/` for
  `jspi/`): engines without JSPI (`WebAssembly.Suspending`) load that one.
- **Commands.** PHP's own CLI runs the arguments (`php script.php …`,
  `php -r code`, `php -v`), with its real exit codes. `php -S host:port [-t
  docroot] [-d name=value] [router.php]` is served request-driven — no socket
  is bound; each request to the virtual port runs through php-wasm's request
  runner with `PHP_SAPI === 'cli-server'`, CGI `$_SERVER`, `$_GET`, `$_POST`,
  `$_COOKIE`, `php://input`, every `Set-Cookie` kept, and a streamed body.
  Routing is the built-in server's: a router's `return false` serves the file
  as is; `.php` files run, others are sent by MIME type; `PATH_INFO`;
  directory indexes; a path without an extension falls back to the nearest
  `index.php` (front controllers such as Slim's `public/index.php`).
  Interactive PHP (`php -a`, or no script) is declined with a reason.
- **Postgres.** php-wasm's images have no `pgsql`/`pdo_pgsql` extension (and
  no libpq to build one), so `new PDO('pgsql:…')` fails with "could not find
  driver". Construct `new \Bfwc\Pgsql\PDO('pgsql:host=localhost;port=5432;dbname=app',
  $user, $password)` instead — loaded in every PHP process without a
  `require`. It *is* a `\PDO` (its statements `\PDOStatement`s), so code typed
  against `PDO` takes it: `prepare`/`execute` with `?` and `:name`,
  `bindValue`/`bindParam`, `query`, `exec` (several statements), transactions,
  `lastInsertId`, the usual fetch modes, SQLSTATE exceptions, results typed as
  pdo_pgsql types them (an `int8` past PHP's 32-bit `PHP_INT_MAX` stays a
  string). As PDO does, mixing `?` and `:name` and a missing parameter are
  `HY093` errors. `COPY … FROM STDIN`/`TO STDOUT` is refused with `0A000`
  (use `INSERT`/`SELECT`); a FATAL from the server is reported as itself. It speaks the Postgres wire protocol over PHP's
  sockets to the PGlite gateway (trust, password and MD5 authentication).
- **Composer.** `composer install | update | require | dump-autoload` (and
  `php composer.phar …`) are done by the runtime, not composer.phar (whose
  network php-wasm cannot give it): versions are resolved from Packagist's
  package API (`https://packagist.org/packages/<name>.json`, which answers
  browsers) or `php.composer.repositoryUrl` (a `{name}` template; Composer v2
  `p2` answers are read too), dists are fetched as zips — through
  `php.composer.distProxy` (a URL prefix) when set, else directly, falling back
  for GitHub-hosted packages to jsDelivr's GitHub mirror at the same commit
  (GitHub's zipballs do not answer browsers) — and `vendor/`, the autoloader
  (PSR-4, PSR-0, class maps, `files`, `Composer\InstalledVersions`) and
  `composer.lock` are written into the project. A lock installs exactly what
  it locks; `update vendor/pkg` moves only the named packages (and what they
  need); `require` takes `vendor/pkg:^1.0`, `vendor/pkg ^1.0` or no
  constraint. Resolution backtracks (a newer release that cannot fit gives way
  to an older one), honours `provide`, `replace` and `conflict` — the root's
  too — and skips releases the running PHP cannot meet. Platform requirements
  are checked against the running PHP: a package needing an extension the
  image lacks (`ext-pgsql`, `ext-redis` …) is declined by name, and
  `createPhpProvider(runtime, { php, platform: runtime.phpPlatform })` declines
  such a service up front (against what PHP processes reported, else the
  pinned release of `php.phpVersion`). composer.json `repositories` other than
  Packagist (`path`, `vcs`, `artifact`, `package`, custom Composer
  repositories, `"packagist.org": false`) are declined, naming their types.
  Names are validated with Composer's own pattern (platform names exactly, so
  `php-di/php-di` is a package); dist URLs must be absolute `https:` (`http:`
  only to a loopback mirror); every package is downloaded before vendor/ is
  touched, so a failed download changes nothing; a dist whose metadata has a
  `shasum` must match it; and every dist is held to size and entry limits
  whichever way it is fetched. A failed `require` or `update` leaves
  composer.json and composer.lock untouched. Composer scripts and plugins do
  not run (it says so).
- **Sockets.** `stream_socket_client`/`fsockopen` reach localhost ports in any
  process through the runtime's virtual TCP. As with php-wasm's own
  networking, a connect returns at once: a port nothing listens on shows as
  end of stream on the first read.
- **Files.** The project is mounted at `/project` in PHP (`node_modules` and
  `.git` are left out), and changes flow both ways, as for Python.
- **Limits.** Standard input is not forwarded (PHP reads end of file); no
  WebSocket or raw-TCP servers in PHP; no `proc_open`; php-wasm is 32-bit
  (`php-64bit` is declined).
- **Relay mode and CSP.** PHP Workers run on the preview origin like Node's:
  serve `dist/php-worker.js` (`phpWorkerSource` in `./assets`) as
  `<scope>/php-worker.js` beside `process-worker.js`. The preview origin's
  CSP must let the Worker import and fetch from the php-wasm base
  (`https://cdn.jsdelivr.net` by default) and compile WebAssembly
  (`'wasm-unsafe-eval'`), and — for `composer` — fetch from `packagist.org`
  (or `repositoryUrl`'s host), the dist hosts packages name (`api.github.com`
  and `codeload.github.com` for GitHub — tried first, then
  `data.jsdelivr.com` and `cdn.jsdelivr.net` when GitHub does not answer the
  browser — and `gitlab.com`, `bitbucket.org` or a custom host for packages
  served there), or only `distProxy`'s host when one is set. `php.baseUrl`
  must be absolute and CORS-served.

### .NET

`dotnet` commands run in a .NET process Worker — Mono's `browser-wasm`
runtime (.NET 10) — beside the Node, Python and PHP processes, on the same
files and ports. The runtime is **a bundle the host serves**, built by
`node scripts/build-dotnet-runtime.mjs` (needs the .NET SDK that
`dotnet-host/global.json` pins, and git; about 73 MiB uncompressed;
`pnpm -C packages/browser build:dotnet`) and passed as
`dotnet.bundleUrl`; this package never contains it, and there is no default —
without `bundleUrl`, `dotnet` commands fail with a message saying so.
`runtime.run('dotnet', ['run'])`, a shell's `dotnet …`, Node's
`spawn('dotnet')` and a file-based program whose shebang names dotnet
(`./app.cs`) all work. A `dotnet` service uses `createDotnetProvider(runtime)`:

```ts
import { startPreviewRuntime } from '@seanhogg/builderforce-webcontainers';
import { createDotnetProvider, createPgliteProvider, startApplicationRuntime } from '@seanhogg/builderforce-webcontainers/app';

const runtime = await startPreviewRuntime({
  serviceWorkerUrl: '/__bfwc/sw.js',
  id: projectId,
  dotnet: { bundleUrl: 'https://assets.example.com/bfwc-dotnet/' }, // the built bundle's directory
});
const app = startApplicationRuntime(
  {
    projectId,
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' },
        database: { engine: 'postgres', provider: 'pglite', persistent: true } },
      { id: 'api', type: 'application', runtime: 'dotnet', root: '/api', command: 'dotnet',
        args: ['run', '--urls', 'http://localhost:5080'], port: 5080, dependsOn: ['db'],
        readiness: { kind: 'http', path: '/health' } },
    ],
  },
  { providers: [createDotnetProvider(runtime, { fs: runtime.fs }), createPgliteProvider(runtime)] },
);
```

The .NET process Worker script itself ships in this package
(`dist/runtimes/dotnet/worker.js`, found beside the module by default;
`node.dotnetWorkerUrl` points elsewhere).

- **Commands.** `dotnet run [--project p] [-c cfg] [--no-build]
  [--launch-profile n | --no-launch-profile] [-- args]` (launch profiles from
  `Properties/launchSettings.json`; their `applicationUrl` becomes
  ASPNETCORE_URLS unless the process already has one), file-based programs
  (`dotnet run app.cs`, `#:sdk`/`#:package`/`#:property`, a `dotnet` shebang),
  `dotnet build [-o dir]`, `dotnet app.dll` / `dotnet exec`, `dotnet clean`
  (removes the built assembly, only ever under the project's `bin/`),
  `dotnet restore` (a check: only bundled packages resolve), `--version`,
  `--info`, `--list-sdks`, `--list-runtimes`. `watch`, `test`, `publish`,
  `new`, `ef`, tools and solutions are declined with a reason.
- **Builds.** Roslyn runs in the runtime and compiles SDK-style C# projects
  (Microsoft.NET.Sdk, .Web, .Worker; `net5.0`–`net10.0`, compiled as
  `net10.0`): every `.cs` under the project but `bin/`/`obj/` and `<Compile
  Remove>`, implicit and `<Using>` global usings, Nullable, LangVersion (by
  default the target framework's: net8.0 → C# 12, net9.0 → 13, net10.0 → 14),
  AllowUnsafeBlocks, DefineConstants, NoWarn, TreatWarningsAsErrors, simple
  `$(Configuration)` conditions and `<Choose>`. A file-based program's `#:`
  directives count only at the top of the file. The assembly lands in
  `bin/<Configuration>/<tfm>/` and reaches the page. Source generators and
  analyzers do not run; Directory.Build.props is not read (a build note says
  so). Project references, `<Compile Include>` outside the project,
  `EnableDefaultCompileItems=false`, properties or items set inside a
  `<Target>`, an AssemblyName that is a path, and NuGet packages beyond the
  bundled **Npgsql 9.0.3** (and the Microsoft.Extensions.* packages ASP.NET
  Core's shared framework carries) are declined with the reason.
- **ASP.NET Core.** Kestrel cannot bind sockets in `browser-wasm`, so every
  host a program builds gets an in-memory `IServer` instead (injected through
  the hosting DiagnosticListener, as `WebApplicationFactory` does): its URLs'
  ports (`--urls`, ASPNETCORE_URLS, `app.Run(url)`; default
  `http://localhost:5000`) open on the virtual network, and requests stream
  through ASP.NET Core's pipeline. Minimal APIs, middleware, routing,
  `appsettings.json` and logging work unchanged; `app.Run()` works although
  the runtime has one thread. A host that fails to start — a URL it cannot
  bind (taken, port 0, no scheme), a hosted service throwing — ends the
  program as an unhandled exception does: the error printed, exit 134.
  Request paths are decoded as Kestrel decodes them (`%2F` kept, dot segments
  removed). No TLS (https URLs serve plain HTTP), no WebSockets.
- **Postgres.** Npgsql is patched (dotnet-host/patches/npgsql-browser.patch)
  so its connections are the runtime's virtual TCP: `Host=localhost;Port=5432`
  reaches the PGlite gateway. Take `Username` and `Password` from the service's
  `DATABASE_URL` userinfo (`new Uri(url).UserInfo`, each part unescaped) and
  fail when the password is missing: the gateway checks the service's
  credentials. Any SSL Mode the gateway can answer works (the
  default, Prefer, goes on in plain text). Use Npgsql's **async** API
  (`OpenAsync`, `ExecuteReaderAsync`, …): with one thread, a synchronous call
  that must wait for the database throws.
- **Integrity and caching.** The bundle's `manifest.json` lists every file's
  SHA-256: the Worker checks `dotnet.js` (which carries Mono's own integrity
  hashes for the rest) and each reference pack before using them, and refuses
  a bundle that does not match, or that is absent or unreachable, with one
  line. In browsers the files are kept in the Cache API under the manifest's
  hash, so a `dotnet build` then a `dotnet run` download each once (each
  process still starts its own runtime).
- **Limits.** One thread (no `Thread`, no blocking waits); no standard input;
  `localhost` is the only reachable host.
- **Relay mode and CSP.** .NET Workers run on the preview origin like Node's:
  serve `dist/dotnet-worker.js` (`dotnetWorkerSource` in `./assets`) as
  `<scope>/dotnet-worker.js` beside `process-worker.js`. `dotnet.bundleUrl`
  must be absolute and CORS-served to the preview origin, whose CSP must let
  the Worker fetch and import from the bundle's host and compile WebAssembly
  (`'wasm-unsafe-eval'`).

### Rust

Rust runs as **prebuilt `wasm32-wasip1` modules** in a Rust process Worker,
on the same preview1 WASI host `node:wasi` uses, beside the Node, Python, PHP
and .NET processes, on the same files and ports. A path to a module
(`./target/wasm32-wasip1/release/api.wasm`) or `wasmtime [run] [--env K=V]
[--dir D] app.wasm args…` runs it — from `runtime.run`, a shell or Node's
`spawn`. Nothing is compiled in the browser (see the gate below): `cargo`,
`rustc` and `rustup` exit 1 with the reason and the prebuilt path. A `rust`
service uses `createRustProvider(runtime, { fs })`, which declares its one
profile (`RUST_PROFILE`) and declines everything else with a reason — a
toolchain command, a module that is missing (not built), not wasm, or a
preview 2 component:

```ts
{ id: 'api', type: 'application', runtime: 'rust', root: '/api',
  command: './target/wasm32-wasip1/release/todo_service.wasm', env: { PORT: '8080' },
  port: 8080, dependsOn: ['db'], readiness: { kind: 'http', path: '/health' } }
```

- **Commands.** A module exporting `_start` is a WASI command: it runs to
  completion with its arguments and exit code, and its writes reach the page.
  Run by path, it gets the process's environment, the project at `/` and the
  working directory at `.`. Under `wasmtime run` it gets only what wasmtime
  would give: `--env K=V` (and `--env K`, inherited from the process),
  `--dir HOST[::GUEST]` preopens.
- **Services (a wasi:http-style handler).** A WASI preview1 module cannot
  block in a browser without threads, so a service is a *reactor*
  (`crate-type = ["cdylib"]`) built with the `bfwc-wasi` crate, which ships
  in this npm package as source. Depend on it by path, from the
  installed package or a vendored copy:

  ```toml
  [lib]
  crate-type = ["cdylib"]

  [dependencies]
  bfwc-wasi = { path = "../node_modules/@seanhogg/builderforce-webcontainers/rust-fixtures/bfwc-wasi" }
  axum = { version = "0.8", default-features = false, features = ["json"] }
  ```

  The app exports `bfwc_start`, which calls `bfwc_wasi::serve(port, router)`
  with an **axum 0.8** `Router`. Each request is handed to the module
  (`bfwc_request`), runs through the router as a task, and is answered whole
  (a status outside 200–599 or a body over 64 MiB answers 502). The host
  drives the tasks (`bfwc_poll`) whenever a request, bytes, room to write or
  a dial arrive; no thread ever waits, no SharedArrayBuffer. tokio's own
  runtime is not used (its `block_on` parks the thread); tokio's I/O traits
  and `sync` primitives work unchanged. ABI version 1: imports `bfwc.{listen,
  respond, connect, send, recv, close}`; exports `bfwc_abi_version`,
  `bfwc_start`, `bfwc_alloc`, `bfwc_request`, `bfwc_poll`. A module built for
  another ABI version, importing a function the runtime lacks, or whose
  `bfwc_start` returns without serving, is declined with the reason.
- **Postgres.** `bfwc_wasi::net::connect(port)` dials a virtual port (the
  PGlite gateway) and implements tokio's `AsyncRead`/`AsyncWrite`, so
  **tokio-postgres 0.7** (`default-features = false`: no `runtime` feature,
  which needs socket2) connects with `Config::connect_raw(stream, NoTls)`;
  spawn the `Connection` with `bfwc_wasi::spawn`. No patches to tokio-postgres
  or axum. Connections are flow-controlled both ways (a write is pending while
  64 KiB is in flight unread); at most 256 are open per process. One import of a dependency (`wasi:cli/environment` from
  `whoami`, linked but never called when the URL names a user) is stubbed:
  imports from modules other than `wasi_snapshot_preview1` and `bfwc` fail
  only if called.
- **Fixture.** `rust-fixtures/todo-service` (axum + tokio-postgres CRUD,
  706 KiB release `.wasm`; `hello`, an 81 KiB command) is built by
  `node scripts/build-rust-fixtures.mjs` (`pnpm build:rust-fixtures`; the
  toolchain is pinned by `rust-fixtures/rust-toolchain.toml`, rustc 1.95.0
  with wasm32-wasip1; ~1.5 min cold). `tests/rust-runtime.test.ts` runs it
  against PGlite (CRUD, a rolled-back transaction, 404). It skips when the
  modules are not built, and fails when `BFWC_RUST_FIXTURES` names them but
  they are missing; CI's `rust-runtime` job builds them.
- **In-browser compile gate: not passed.** rustc runs in a browser only as a
  community `wasm32-wasip1-threads` build, which needs shared memory —
  SharedArrayBuffer and cross-origin isolation, which this runtime never
  requires. It would also need a large download: on the measured toolchain
  (rustc 1.95), the compiler with LLVM (`rustc_driver`) is 184 MiB native,
  the wasm32-wasip1 sysroot 96 MiB, and the linker (`rust-lld`) 108 MiB.
  Building the fixture also pulls 217 dependency rlibs (98 MiB) from
  crates.io. No in-browser compiler ships until this gate passes
  (`RUST_COMPILE_GATE`).
- **Limits.** Preview1 only (components and `wasmtime serve` are declined);
  one served port per process; responses are buffered, not streamed; no
  WebSockets or inbound raw TCP; no half-close (`poll_shutdown` is a no-op —
  dropping the stream hangs up); no timers (`tokio::time` needs a runtime and
  panics); no standard input; a trap ends the process with 134.
- **Relay mode and CSP.** Serve `dist/rust-worker.js` (`rustWorkerSource` in
  `./assets`) as `<scope>/rust-worker.js` beside `process-worker.js`
  (`node.rustWorkerUrl` otherwise); the preview origin's CSP must allow
  `'wasm-unsafe-eval'`.
