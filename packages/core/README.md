# @seanhogg/builderforce-webcontainers-core

The runtime-agnostic dev server behind
[BuilderForce WebContainers](https://github.com/SeanHogg/builderforce-webcontainers).
It turns a project held in a `VirtualFileSystem` into browser-ready responses:
compiled ES modules, CSS/JSON/asset wrappers and the HTML document. It never
listens on anything; you call `handle(path, search)`.

```ts
import * as esbuild from 'esbuild';
import { VirtualFileSystem, DevServer, createEsbuildTransformer } from '@seanhogg/builderforce-webcontainers-core';

const fs = new VirtualFileSystem();
fs.writeTree({ 'index.html': '...', 'src/main.tsx': '...' });
const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/preview/' });
const res = await server.handle('/src/main.tsx'); // { status, headers, body }
```

Components compile through the `ComponentCompilers` port: Vue and Svelte by
file extension, and Angular 17–20 (standalone, JIT) for the TypeScript of a
project depending on `@angular/core` — see `angularCompilerFor` and the
[browser README](../browser/README.md#angular) for what is supported.

For the in-browser runtime, use
[`@seanhogg/builderforce-webcontainers`](../browser). MIT licensed.
