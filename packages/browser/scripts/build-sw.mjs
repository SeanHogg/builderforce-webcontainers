// Bundle the service worker into ONE self-contained classic script. A worker is
// registered by URL, so it cannot import the package's ES modules at runtime —
// it ships as dist/sw.js for the host to serve.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/sw.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  outfile: 'dist/sw.js',
});
