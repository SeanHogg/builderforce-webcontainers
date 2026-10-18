/**
 * SvelteKit's dev server (the real, installed Vite) from a project directory
 * below the file-system root. At `/`, chokidar records `basename('/')` (`''`) as
 * a child of `/` and every rescan unwatches the project, so Vite restarted on a
 * phantom "vite.config.js changed". Needs the network: BFWC_NETWORK=1.
 */
import { describe, expect, it } from 'vitest';
import { kernelWith, readAll } from '../node/helpers.js';
import { createMemoryCache } from '../../src/installer/registry.js';

const ROOT = '/home/project';

const files = {
  'package.json': JSON.stringify({
    name: 'kit-app',
    type: 'module',
    scripts: { dev: 'vite dev' },
    devDependencies: { '@sveltejs/kit': '^2.20.0', '@sveltejs/adapter-auto': '^6.0.0', '@sveltejs/vite-plugin-svelte': '^5.0.0', svelte: '^5.25.0', vite: '^6.2.0' },
  }),
  'svelte.config.js': `import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n`,
  'vite.config.js': `import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [sveltekit()] });\n`,
  'src/app.html': '<!doctype html><html><head>%sveltekit.head%</head><body><div>%sveltekit.body%</div></body></html>\n',
  'src/routes/+page.svelte': '<h1>Hello from kit</h1>\n',
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(process.env.BFWC_NETWORK === '1')('SvelteKit dev server (network)', () => {
  it('serves its page and does not restart on its own', async () => {
    const kernel = kernelWith({}, { packageCache: createMemoryCache() });
    kernel.fs.writeTree(files, ROOT);
    const install = kernel.run('npm', ['install'], { cwd: ROOT });
    const installLog = readAll(install.combinedOutput);
    expect(await install.wait(), await installLog).toBe(0);

    const ready = new Promise<number>((resolve) => kernel.servers.onListening(({ port }) => resolve(port)));
    const dev = kernel.run('npm', ['run', 'dev'], { cwd: ROOT });
    let log = '';
    const reading = (async () => {
      const reader = dev.combinedOutput.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        log += value;
      }
    })();
    const port = await ready;
    await settle(15_000); // the phantom restarts came within seconds of start-up

    const page = await kernel.request(port, { url: '/' });
    dev.kill();
    await reading;
    expect(log).not.toMatch(/changed, restarting|server restarted/i);
    expect(page?.status, log).toBe(200);
    expect(new TextDecoder().decode(page?.body)).toContain('Hello from kit');
  }, 300_000);
});
