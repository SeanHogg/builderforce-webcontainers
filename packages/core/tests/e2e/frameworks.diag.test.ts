/**
 * TEMPORARY diagnostics (delete once item 15 is closed): the SvelteKit restart at
 * `/` for comparison, and where Nuxt 4 start-up waits. Prints, never asserts.
 * BFWC_NETWORK=1 BFWC_DIAG=1.
 */
import { describe, it } from 'vitest';
import { kernelWith } from '../node/helpers.js';
import { createMemoryCache } from '../../src/installer/registry.js';
import type { Kernel } from '../../src/system/kernel.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Record the last file-system reads and every fetch, to see what start-up touched last. */
function trace(kernel: Kernel) {
  const reads: string[] = [];
  const fs = kernel.fs as unknown as Record<string, (path: string, ...rest: unknown[]) => unknown>;
  for (const method of ['readFile', 'isFile', 'isDirectory', 'readdir']) {
    const original = fs[method]!.bind(kernel.fs);
    fs[method] = (path, ...rest) => {
      reads.push(`${method} ${path}`);
      if (reads.length > 400) reads.shift();
      return original(path, ...rest);
    };
  }
  return reads;
}

async function collect(stream: ReadableStream<string>, into: { log: string }) {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    into.log += value;
  }
}

async function install(kernel: Kernel, cwd: string) {
  const out = { log: '' };
  const proc = kernel.run('npm', ['install'], { cwd });
  const reading = collect(proc.combinedOutput, out);
  const code = await proc.wait();
  await reading;
  console.log(`--- npm install in ${cwd}: exit ${code}\n${out.log.slice(-3000)}`);
}

describe.runIf(process.env.BFWC_NETWORK === '1' && process.env.BFWC_DIAG === '1')('framework diagnostics', () => {
  it('SvelteKit at / (expected: phantom restarts)', async () => {
    const kernel = kernelWith({
      'package.json': JSON.stringify({ name: 'kit-app', type: 'module', scripts: { dev: 'vite dev' }, devDependencies: { '@sveltejs/kit': '^2.20.0', '@sveltejs/adapter-auto': '^6.0.0', '@sveltejs/vite-plugin-svelte': '^5.0.0', svelte: '^5.25.0', vite: '^6.2.0' } }),
      'svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n`,
      'vite.config.js': `import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [sveltekit()] });\n`,
      'src/app.html': '<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>\n',
      'src/routes/+page.svelte': '<h1>Hello from kit</h1>\n',
    }, { packageCache: createMemoryCache() });
    await install(kernel, '/');
    const out = { log: '' };
    const dev = kernel.run('npm', ['run', 'dev'], { cwd: '/' });
    const reading = collect(dev.combinedOutput, out);
    await settle(30_000);
    dev.kill();
    await reading;
    console.log(`--- SvelteKit at /, 30 s of output:\n${out.log}`);
  }, 300_000);

  it('Nuxt 4 start-up', async () => {
    const root = '/home/project';
    const kernel = kernelWith({}, {
      packageCache: createMemoryCache(),
      fetch: (input, init) => {
        console.log(`[fetch] ${init?.method ?? 'GET'} ${String(input)}`);
        return globalThis.fetch(input, init);
      },
    });
    kernel.fs.writeTree({
      'package.json': JSON.stringify({ name: 'nuxt-app', type: 'module', private: true, scripts: { dev: 'nuxt dev --no-fork' }, dependencies: { nuxt: '^4.0.0', vue: '^3.5.0' } }),
      'app/app.vue': '<template><h1>Hello from nuxt</h1></template>\n',
      'nuxt.config.ts': 'export default defineNuxtConfig({ devtools: { enabled: false }, telemetry: false });\n',
    }, root);
    await install(kernel, root);
    console.log(`--- top-level oxc packages: ${kernel.fs.readdir(`${root}/node_modules`).filter((n) => n.includes('oxc')).join(', ')}`);
    console.log(`--- @oxc-parser: ${kernel.fs.readdir(`${root}/node_modules/@oxc-parser`).join(', ')}`);

    const reads = trace(kernel);
    let listening = 'never';
    kernel.servers.onListening(({ port }) => (listening = String(port)));
    const out = { log: '' };
    const dev = kernel.run('npm', ['run', 'dev'], { cwd: root, env: { DEBUG: 'nuxt:*', CONSOLA_LEVEL: '5', NUXT_TELEMETRY_DISABLED: '1' } });
    const reading = collect(dev.combinedOutput, out);
    await settle(90_000);
    console.log(`--- Nuxt 4: listening on ${listening}; output:\n${out.log}`);
    console.log(`--- last file-system reads (oldest first):\n${reads.slice(-150).join('\n')}`);
    dev.kill();
    await Promise.race([reading, settle(5_000)]);
  }, 600_000);
});
