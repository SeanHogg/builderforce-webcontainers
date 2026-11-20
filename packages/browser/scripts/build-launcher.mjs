// Build the local launcher's page (make.md › PRD 31 §4 W11): the files
// `createLocalLauncher` (dist/launcher/server, compiled by tsc) serves on the host
// page's origin —
//   dist/launcher/page.js       the page, ONE ES module with the runtime inlined
//                                (an ES module, so `import.meta.url` stays meaningful);
//   dist/launcher/index.html    its document;
//   dist/launcher/launcher.css  its stylesheet.
// Run after build-sw.mjs (the server also needs dist/assets.js).
import { build } from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

await mkdir('dist/launcher', { recursive: true });
const page = await build({
  entryPoints: ['src/launcher/page/main.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
});
await writeFile('dist/launcher/page.js', page.outputFiles[0].text);
await copyFile('src/launcher/page/index.html', 'dist/launcher/index.html');
await copyFile('src/launcher/page/launcher.css', 'dist/launcher/launcher.css');
