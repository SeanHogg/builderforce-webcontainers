# @seanhogg/builderforce-webcontainers

The browser runtime of
[BuilderForce WebContainers](https://github.com/SeanHogg/builderforce-webcontainers):
boot an in-browser dev server and preview the project in an iframe. No COOP/COEP
headers, no session caps, MIT licensed.

1. Serve `dist/sw.js` from your site, ideally at `/__bfwc/sw.js` so the worker's
   scope stays off the rest of your app. You can resolve its path with
   `import.meta.resolve('@seanhogg/builderforce-webcontainers/sw.js')`, or copy it
   in your build.
2. Boot and mount:

```ts
import { bootPreviewRuntime } from '@seanhogg/builderforce-webcontainers';

const runtime = await bootPreviewRuntime({ serviceWorkerUrl: '/__bfwc/sw.js', id: projectId });
runtime.mount(files);
if (runtime.profile().supported) iframe.src = runtime.url;
else showFallback(runtime.profile().reason);
```

To run untrusted code (AI-written, arbitrary packages), isolate the preview on its
own origin with `bootPreviewRuntime({ relayUrl })`. That origin serves
`relay.html` and `sw.js` (strings in `@seanhogg/builderforce-webcontainers/assets`)
with `Content-Security-Policy: frame-ancestors` limited to your app. See the
[root README](../../README.md#isolating-the-preview-relay-mode).

The package re-exports everything from
[`@seanhogg/builderforce-webcontainers-core`](../core).
