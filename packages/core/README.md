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
fs.mount({ 'index.html': '...', 'src/main.tsx': '...' });
const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/preview/' });
const res = await server.handle('/src/main.tsx'); // { status, headers, body }
```

For the in-browser runtime, use
[`@seanhogg/builderforce-webcontainers`](../browser). MIT licensed.
