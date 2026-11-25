# @seanhogg/builderforce-webcontainers-core

The runtime-agnostic dev server behind
[BuilderForce WebContainers](https://github.com/SeanHogg/builderforce-webcontainers).
It turns a project held in a `VirtualFileSystem` into browser-ready responses:
compiled ES modules, CSS/JSON/asset wrappers and the HTML document. It never
listens on anything; you call `handle(path, search)`.

## Where this fits
Part of BuilderForce's **Idea → Make → Run → Measure → Reach** method ([definitions](https://github.com/SeanHogg/Builderforce.ai/blob/main/docs/specs/README.md)). This package serves **Make** and **Run**: the runtime-agnostic dev server that turns a project in the virtual file system into browser-ready responses.

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

## API overview

Exported from `src/index.ts`:

| Area | Exports |
|---|---|
| File system | `VirtualFileSystem`, `VfsSnapshots`, `mountSnapshot`, `rootedFileSystem`, `exportZip`, `importZip` |
| Dev server | `DevServer`, `detectProject`, `readProjectConfig`, `ModuleGraph`, `planUpdate` |
| Compile | `createEsbuildTransformer`, `createEsbuildBundler`, `compileScript`, `compileComponent`, `compileStylesheet`, `rewriteImports` |
| Build | `buildProject`, `createBuildHost`, `findHtmlEntries`, `rewriteBuiltHtml` |
| Packages | `createEsmShCdn`, `loadPackageManifests`, `resolvePackage`, `resolveLocal` |
| Preview bridges | `transformHtml`, `previewDiagnosticsScript`, `previewSocketScript`, `hotUpdateScript` |
| WASI | `createVfsWasi`, `WasiExit` |

For the in-browser runtime, use
[`@seanhogg/builderforce-webcontainers`](../browser). MIT licensed.
