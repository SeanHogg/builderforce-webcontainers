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
