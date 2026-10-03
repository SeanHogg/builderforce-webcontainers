// Bundle the two files a preview origin serves, each ONE self-contained script:
//   dist/sw.js       the service worker (registered by URL, so it cannot import
//                    the package's ES modules at runtime);
//   dist/relay.html  the cross-origin relay page, script inlined;
//   dist/check/worker.js  the type-check worker.
// dist/assets.js exports both as strings, so a server (a Worker, an Express app)
// can serve them straight from the installed package without copying files.
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

await writeFile('dist/sw.js', serviceWorker);
await writeFile('dist/relay.html', relayHtml);
await writeFile(
  'dist/assets.js',
  `/** The preview service worker's source — serve as \`<scope>/sw.js\`, text/javascript. */\n` +
    `export const serviceWorkerSource = ${JSON.stringify(serviceWorker)};\n` +
    `/** The cross-origin relay page — serve as \`<scope>/relay.html\`, text/html, with frame-ancestors set. */\n` +
    `export const relayHtml = ${JSON.stringify(relayHtml)};\n`,
);
await writeFile(
  'dist/assets.d.ts',
  `/** The preview service worker's source — serve as \`<scope>/sw.js\`, text/javascript. */\n` +
    `export declare const serviceWorkerSource: string;\n` +
    `/** The cross-origin relay page — serve as \`<scope>/relay.html\`, text/html, with frame-ancestors set. */\n` +
    `export declare const relayHtml: string;\n`,
);
