// Bundle the two files a preview origin serves, each ONE self-contained script:
//   dist/sw.js       the service worker (registered by URL, so it cannot import
//                    the package's ES modules at runtime);
//   dist/relay.html  the cross-origin relay page, script inlined;
//   dist/check/worker.js  the type-check worker;
//   dist/node/worker.js   the process worker (Node runtime, npm, shell);
//   dist/runtimes/python/worker.js  the Python process worker (Pyodide);
//   dist/inference/worker.bundle.js  the local inference worker (Phase 1).
// dist/assets.js exports what a preview origin serves (the service worker, the
// relay page, the Node and Python process workers) as strings, so a server (a
// Worker, an Express app) can serve them straight from the installed package
// without copying files.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
  });
  return result.outputFiles[0].text;
}

const serviceWorker = await bundle('src/sw.ts');
// `</script` cannot appear in the minified output of these sources, but escape it
// anyway so the inline script can never end early.
const relayScript = (await bundle('src/relay.ts')).replace(/<\/script/gi, '<\/script');
const relayHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Preview relay</title></head><body><script>${relayScript}</script></body></html>\n`;

// The check worker: a classic script (it loads TypeScript with importScripts), with
// the core's checker inlined. `createChecker()` finds it beside dist/check/index.js.
await mkdir('dist/check', { recursive: true });
await writeFile('dist/check/worker.js', await bundle('src/check/worker.ts'));

// The process worker: one per spawned process (node, npm, bfsh), with the whole
// core runtime inlined. The host finds it beside dist/node/index.js.
await mkdir('dist/node', { recursive: true });
const processWorker = await bundle('src/node/worker.ts');
await writeFile('dist/node/worker.js', processWorker);
// The same script, named for the preview origin: in relay mode the relay starts
// process workers from `<scope>/process-worker.js`, so the server hosting
// relay.html serves this beside it.
await writeFile('dist/process-worker.js', processWorker);

// The Python process worker: one per Python process (python, pip, uvicorn, …),
// Pyodide loaded from the CDN at start. The host finds it at
// dist/runtimes/python/worker.js (beside tsc's runtimes/python modules); the
// relay starts it from `<scope>/python-worker.js`, served beside relay.html.
await mkdir('dist/runtimes/python', { recursive: true });
const pythonWorker = await bundle('src/runtimes/python/worker.ts');
await writeFile('dist/runtimes/python/worker.js', pythonWorker);
await writeFile('dist/python-worker.js', pythonWorker);

// The local inference worker (Phase 1): self-contained so it can run on a
// dedicated worker thread. It gets its OWN path — dist/inference/worker.js is
// tsc's ES module (startInferenceWorkerHost / runInferenceWorker, re-exported
// by ./ml) and must not be overwritten. The client finds the bundle beside
// dist/inference/client.js; package.json exports it as `./ml/worker.js`.
await mkdir('dist/inference', { recursive: true });
await writeFile('dist/inference/worker.bundle.js', await bundle('src/inference/workerEntry.ts'));

await writeFile('dist/sw.js', serviceWorker);
await writeFile('dist/relay.html', relayHtml);
await writeFile(
  'dist/assets.js',
  `/** The preview service worker's source — serve as \`<scope>/sw.js\`, text/javascript. */\n` +
    `export const serviceWorkerSource = ${JSON.stringify(serviceWorker)};\n` +
    `/** The cross-origin relay page — serve as \`<scope>/relay.html\`, text/html, with frame-ancestors set. */\n` +
    `export const relayHtml = ${JSON.stringify(relayHtml)};\n` +
    `/** The process worker — serve as \`<scope>/process-worker.js\`, text/javascript, beside relay.html. */\n` +
    `export const processWorkerSource = ${JSON.stringify(processWorker)};\n` +
    `/** The Python process worker — serve as \`<scope>/python-worker.js\`, text/javascript, beside relay.html. */\n` +
    `export const pythonWorkerSource = ${JSON.stringify(pythonWorker)};\n`,
);
await writeFile(
  'dist/assets.d.ts',
  `/** The preview service worker's source — serve as \`<scope>/sw.js\`, text/javascript. */\n` +
    `export declare const serviceWorkerSource: string;\n` +
    `/** The cross-origin relay page — serve as \`<scope>/relay.html\`, text/html, with frame-ancestors set. */\n` +
    `export declare const relayHtml: string;\n` +
    `/** The process worker — serve as \`<scope>/process-worker.js\`, text/javascript, beside relay.html. */\n` +
    `export declare const processWorkerSource: string;\n` +
    `/** The Python process worker — serve as \`<scope>/python-worker.js\`, text/javascript, beside relay.html. */\n` +
    `export declare const pythonWorkerSource: string;\n`,
);
