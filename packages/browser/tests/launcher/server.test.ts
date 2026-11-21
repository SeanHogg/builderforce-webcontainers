/**
 * The local launcher's server (`./launcher/server`): its origins and the Host
 * allowlist, the per-launch token, `launch.json`, the bounded project tree, the
 * change stream, the runtime files' headers on each origin, and `close()`.
 * Needs the built package (dist/assets.js, dist/launcher/page.js).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createLocalLauncher, type LocalLauncher } from '../../src/launcher/server/index.js';
import { LAUNCH_TOKEN_HEADER, type LaunchInfo, type ProjectChange, type ProjectSnapshot } from '../../src/launcher/protocol.js';
import { NODE_MANIFEST, get, launcherRequest, tempProject, tokenOf, trustCa } from './launcherHelpers.js';

const KEY = '0123456789abcdef0123456789abcdef';
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** ONE local CA for the file (never the user's `~/.builderforce`). */
const CA_DIR = mkdtempSync(join(tmpdir(), 'bfwc-launch-ca-'));
const TLS = { storeDir: CA_DIR };
afterAll(() => rmSync(CA_DIR, { recursive: true, force: true }));

async function launch(files: Record<string, string | Uint8Array>, options: Partial<Parameters<typeof createLocalLauncher>[0]> = {}) {
  const project = tempProject(files);
  cleanups.push(project.cleanup);
  const launcher = await createLocalLauncher({ projectDir: project.dir, tls: TLS, ...options });
  trustCa(launcher.caCertPath ? readFileSync(launcher.caCertPath, 'utf8') : undefined);
  cleanups.push(() => launcher.close());
  const page = `localhost:${launcher.port}`;
  const auth = { [LAUNCH_TOKEN_HEADER]: tokenOf(launcher.url) };
  return { launcher, project, page, auth, port: launcher.port };
}

async function json<T>(launcher: LocalLauncher, path: string): Promise<T> {
  const response = await get(launcher.port, `localhost:${launcher.port}`, path, { [LAUNCH_TOKEN_HEADER]: tokenOf(launcher.url) });
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as T;
}

describe('createLocalLauncher: origins and the Host allowlist', () => {
  it('answers on localhost, 127.0.0.1 and <key>.localhost of its own port, binding loopback only', async () => {
    const { launcher, port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    expect(launcher.url).toMatch(new RegExp(`^https://localhost:${port}/#token=[A-Za-z0-9_-]{16,}$`));
    expect((await get(port, `localhost:${port}`, '/')).status).toBe(200);
    expect((await get(port, `127.0.0.1:${port}`, '/__bfwc/relay.html')).status).toBe(200);
    expect((await get(port, `${KEY}.localhost:${port}`, '/__bfwc/relay.html')).status).toBe(200);
  });

  it('refuses every other Host (DNS rebinding), a wrong port, and a key that is not 32 hex', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`, 'localhost', `abc.localhost:${port}`, `${KEY}.localhost.evil:${port}`, `x.${KEY}.localhost:${port}`, `[::1]:${port}`]) {
      const response = await get(port, host, '/', {}, 'GET', 'localhost'); // a valid handshake, then the Host guard
      expect(response.status, host).toBe(403);
    }
  });

  it('serves https with the local CA: a trusted request to localhost succeeds; a server name outside the allowlist gets no certificate', async () => {
    const { auth, port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    expect((await get(port, `localhost:${port}`, '/__bf/launch.json', auth)).status).toBe(200);
    for (const name of ['evil.localhost.example', 'example.com', `abc.localhost`]) {
      await expect(get(port, `${name}:${port}`, '/__bf/launch.json', auth), name).rejects.toThrow();
    }
  });

  it('the app origins’ probe answers the host page only; the .NET bundle is readable only by the launcher’s preview origins', async () => {
    const bundle = tempProject({ 'manifest.json': '{"format":1}', '_framework/dotnet.js': 'export {};' });
    cleanups.push(bundle.cleanup);
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST }, { dotnetBundleDir: bundle.dir });
    const probe = await get(port, `${KEY}.localhost:${port}`, '/__bfwc/probe');
    expect(probe.status).toBe(204);
    expect(probe.headers['access-control-allow-origin']).toBe(`https://localhost:${port}`);
    const relayRead = await get(port, `127.0.0.1:${port}`, '/dotnet/_framework/dotnet.js', { Origin: `https://${KEY}.localhost:${port}` });
    expect(relayRead.headers['access-control-allow-origin']).toBe(`https://${KEY}.localhost:${port}`);
    for (const origin of ['https://evil.example', `https://localhost:${port}`, `http://${KEY}.localhost:${port}`, 'null']) {
      const read = await get(port, `127.0.0.1:${port}`, '/dotnet/_framework/dotnet.js', { Origin: origin });
      expect(read.status, origin).toBe(200);
      expect(read.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });

  it('with tls: false, serves http (tests only): the page then refuses to boot applications', async () => {
    const { launcher, port } = await launch({ 'builderforce.json': NODE_MANIFEST }, { tls: false });
    expect(launcher.url.startsWith(`http://localhost:${port}/`)).toBe(true);
    expect(launcher.caCertPath).toBeNull();
    const info = await json<LaunchInfo>(launcher, '/__bf/launch.json');
    expect(info.relayUrl).toBe(`http://127.0.0.1:${port}/__bfwc/relay.html`);
  });
});

describe('createLocalLauncher: the /__bf API', () => {
  it('requires the per-launch token on every endpoint', async () => {
    const { page, port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    for (const path of ['/__bf/launch.json', '/__bf/files', '/__bf/changes', '/__bf/nope']) {
      expect((await get(port, page, path)).status, path).toBe(403);
      expect((await get(port, page, path, { [LAUNCH_TOKEN_HEADER]: 'wrong-token-wrong-token' })).status, path).toBe(403);
    }
  });

  it('is served on the host page origin only', async () => {
    const { auth, port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    expect((await get(port, `127.0.0.1:${port}`, '/__bf/launch.json', auth)).status).toBe(404);
    expect((await get(port, `${KEY}.localhost:${port}`, '/__bf/files', auth)).status).toBe(404);
  });

  it('launch.json: a stable project id, the manifest text and every URL the page needs', async () => {
    const { launcher, project, port } = await launch({ 'builderforce.json': NODE_MANIFEST }, { environment: 'local', labels: { restart: 'Neu starten' } });
    const info = await json<LaunchInfo>(launcher, '/__bf/launch.json');
    expect(info).toMatchObject({
      projectId: launcher.projectId,
      environment: 'local',
      manifestText: NODE_MANIFEST,
      manifestSource: 'legacy',
      relayUrl: `https://127.0.0.1:${port}/__bfwc/relay.html`,
      previewOriginTemplate: `https://{key}.localhost:${port}`,
      hostWorkerUrl: `https://localhost:${port}/__bfwc/process-worker.js`,
      labels: { restart: 'Neu starten' },
    });
    expect(info.projectId).toMatch(/^p[0-9a-f]{24}$/);
    expect(info.manifestPath.endsWith('builderforce.json')).toBe(true);
    expect(info.dotnet.bundleUrl).toBeNull();
    // The same directory, launched again: the same id (so the same preview origins and storage).
    const again = await createLocalLauncher({ projectDir: project.dir, tls: TLS });
    cleanups.push(() => again.close());
    expect(again.projectId).toBe(launcher.projectId);
  });

  it('launch.json: the manifest override, a missing manifest, and a .NET bundle directory', async () => {
    const bundle = tempProject({ 'manifest.json': '{"format":1}', '_framework/dotnet.js': 'export {};' });
    cleanups.push(bundle.cleanup);
    const { launcher, port } = await launch({ 'server.js': '' }, { manifestText: NODE_MANIFEST, dotnetBundleDir: bundle.dir });
    const info = await json<LaunchInfo>(launcher, '/__bf/launch.json');
    expect(info).toMatchObject({ manifestText: NODE_MANIFEST, manifestSource: 'override', environment: null, dotnet: { bundleUrl: `https://127.0.0.1:${port}/dotnet/` } });
    const file = await get(port, `127.0.0.1:${port}`, '/dotnet/_framework/dotnet.js');
    expect(file.status).toBe(200);
    expect(file.headers['access-control-allow-origin']).toBeUndefined(); // never `*`: only the launcher's preview origins
    expect((await get(port, `127.0.0.1:${port}`, '/dotnet/../server.js')).status).toBe(404);

    const missing = await launch({ 'server.js': '' });
    expect(await json<LaunchInfo>(missing.launcher, '/__bf/launch.json')).toMatchObject({ manifestText: null, manifestSource: 'missing' });
  });

  it('files: text and binary, exclusions, and every cap listed in skipped', async () => {
    const { launcher } = await launch(
      {
        'builderforce.json': NODE_MANIFEST,
        'server.js': 'console.log(1)',
        'img/logo.png': new Uint8Array([137, 80, 78, 71, 0, 1, 2]),
        'big.txt': 'x'.repeat(5_000),
        'node_modules/a/index.js': 'no',
        'src/node_modules/b.js': 'no',
        '.git/HEAD': 'no',
        'dist/out.js': 'no',
        '.next/x': 'no',
        'bin/Debug/a.dll': 'no',
        'obj/a': 'no',
        'vendor/autoload.php': 'no',
        '__pycache__/a.pyc': 'no',
        '.venv/x': 'no',
      },
      { limits: { maxFiles: 3, maxFileBytes: 1_000, maxTotalBytes: 10_000 } },
    );
    const tree = await json<ProjectSnapshot>(launcher, '/__bf/files');
    const all = [...Object.keys(tree.files), ...Object.keys(tree.binary)];
    expect(all.some((path) => /node_modules|\.git|dist|\.next|bin|obj|vendor|__pycache__|\.venv/.test(path))).toBe(false);
    expect(tree.binary['img/logo.png']).toBe(Buffer.from([137, 80, 78, 71, 0, 1, 2]).toString('base64'));
    expect(tree.skipped).toContain('big.txt'); // over the per-file cap
    // Three files fit the count cap (sorted walk: builderforce.json, img/logo.png, server.js); nothing else was dropped silently.
    expect(all.length + tree.skipped.length).toBe(4);
    expect(all.length).toBe(3);
  });

  it('files: past the total cap, the rest is listed in skipped', async () => {
    const { launcher } = await launch({ 'a.txt': 'a'.repeat(60), 'b.txt': 'b'.repeat(60), 'c.txt': 'c' }, { limits: { maxFiles: 100, maxFileBytes: 1_000, maxTotalBytes: 100 } });
    const tree = await json<ProjectSnapshot>(launcher, '/__bf/files');
    expect(Object.keys(tree.files).sort()).toEqual(['a.txt', 'c.txt']);
    expect(tree.skipped).toEqual(['b.txt']);
  });

  it('files: refuses links that resolve outside the project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'bfwc-outside-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET');
    const { launcher, project } = await launch({ 'builderforce.json': NODE_MANIFEST, 'ok.txt': 'fine' });
    symlinkSync(outside, join(project.dir, 'escape'), 'junction'); // a directory link (no privilege needed on Windows)
    let fileLink = true;
    try {
      symlinkSync(join(outside, 'secret.txt'), join(project.dir, 'leak.txt'), 'file');
    } catch {
      fileLink = false; // file symlinks need a privilege on Windows: the directory link still proves containment
    }
    const response = await get(launcher.port, `localhost:${launcher.port}`, '/__bf/files', { [LAUNCH_TOKEN_HEADER]: tokenOf(launcher.url) });
    expect(response.body).not.toContain('TOP SECRET');
    const tree = JSON.parse(response.body) as ProjectSnapshot;
    expect(tree.skipped).toContain('escape');
    if (fileLink) expect(tree.skipped).toContain('leak.txt');
    expect(tree.files['ok.txt']).toBe('fine');
  });

  it('changes: streams a write and a delete as server-sent events', async () => {
    const { launcher, project } = await launch({ 'builderforce.json': NODE_MANIFEST, 'gone.txt': 'bye' }, { watchDebounceMs: 30 });
    const events: ProjectChange[] = [];
    const req = launcherRequest({ host: '127.0.0.1', port: launcher.port, path: '/__bf/changes', headers: { Host: `localhost:${launcher.port}`, [LAUNCH_TOKEN_HEADER]: tokenOf(launcher.url) } });
    const connected = new Promise<void>((resolve, reject) => {
      req.on('response', (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const data = block.split('\n').find((line) => line.startsWith('data: '));
            if (data) events.push(JSON.parse(data.slice(6)) as ProjectChange);
          }
        });
        resolve();
      });
      req.on('error', reject);
    });
    req.end();
    cleanups.push(() => req.destroy());
    await connected;
    await new Promise((resolve) => setTimeout(resolve, 150)); // the watch is up
    writeFileSync(join(project.dir, 'hello.txt'), 'hi there');
    unlinkSync(join(project.dir, 'gone.txt'));
    mkdirSync(join(project.dir, 'node_modules'), { recursive: true });
    writeFileSync(join(project.dir, 'node_modules', 'ignored.js'), 'no');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !(events.some((e) => e.path === 'hello.txt' && e.content === 'hi there') && events.some((e) => e.path === 'gone.txt' && e.deleted))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(events).toContainEqual({ path: 'hello.txt', content: 'hi there' });
    expect(events).toContainEqual({ path: 'gone.txt', deleted: true });
    expect(events.some((e) => e.path.includes('node_modules'))).toBe(false);
  }, 15_000);
});

describe('createLocalLauncher: runtime files and their headers', () => {
  it('relay.html on the relay and app origins: framed only by the host page, never cached', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    for (const host of [`127.0.0.1:${port}`, `${KEY}.localhost:${port}`]) {
      const relay = await get(port, host, '/__bfwc/relay.html');
      expect(relay.status).toBe(200);
      expect(relay.headers['content-type']).toContain('text/html');
      expect(relay.headers['content-security-policy']).toBe(
        `default-src 'none'; script-src 'unsafe-inline'; worker-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://localhost:${port}`,
      );
      expect(relay.headers['cache-control']).toBe('no-store');
      expect(relay.headers['x-content-type-options']).toBe('nosniff');
      expect(relay.headers['origin-agent-cluster']).toBe('?1');
    }
  });

  it('sw.js only in relay mode, with no policy, report, csp or unknown key and egress within the package CDN', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    const host = `${KEY}.localhost:${port}`;
    const ok = await get(port, host, '/__bfwc/sw.js?mode=relay&egress=https%3A%2F%2Fesm.sh', { 'Service-Worker': 'script' });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-security-policy']).toBe("default-src 'none'; connect-src 'self'");
    expect(ok.headers['cache-control']).toBe('no-cache');
    // `csp` (preview code re-registering sw.js to make its own CSP report-only), any unknown key and any repeated key are refused too.
    for (const query of ['', '?mode=same-origin', '?mode=relay&policy=abc', '?mode=relay&report=https%3A%2F%2Fx.example%2Fr', '?mode=relay&egress=https%3A%2F%2Fevil.example', '?mode=relay&csp=report-only', '?mode=relay&egress=https%3A%2F%2Fesm.sh&csp=report-only', '?mode=relay&csp=enforce', '?mode=relay&future=1', '?mode=relay&mode=relay', '?mode=same-origin&mode=relay', '?mode=relay&egress=https%3A%2F%2Fesm.sh&egress=https%3A%2F%2Fevil.example', '?mode=relay&egress=https%3A%2F%2Fesm.sh&egress=https%3A%2F%2Fesm.sh']) {
      const refused = await get(port, host, `/__bfwc/sw.js${query}`);
      expect(refused.status, query).toBe(403);
      expect(refused.headers['content-security-policy']).toContain(`frame-ancestors https://localhost:${port}`);
    }
  });

  it('process Workers get the most restrictive policy and can never be registered as a service worker', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    for (const name of ['process-worker.js', 'python-worker.js', 'php-worker.js', 'dotnet-worker.js', 'rust-worker.js']) {
      const worker = await get(port, `127.0.0.1:${port}`, `/__bfwc/${name}?policy=x`);
      expect(worker.status, name).toBe(200);
      const csp = String(worker.headers['content-security-policy']);
      expect(csp).toContain("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://registry.npmjs.org");
      expect(csp).toContain('connect-src https://registry.npmjs.org');
      expect(csp).not.toContain("connect-src 'self'");
      expect((await get(port, `127.0.0.1:${port}`, `/__bfwc/${name}`, { 'Service-Worker': 'script' })).status, name).toBe(403);
    }
  });

  it('anything else on a preview origin is a 404 with the preview document policy; non-GET is a 405', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    const host = `${KEY}.localhost:${port}`;
    const missing = await get(port, host, '/index.html');
    expect(missing.status).toBe(404);
    const csp = String(missing.headers['content-security-policy']);
    expect(csp).toContain(`connect-src 'self' ws://${host} wss://${host}`);
    expect(csp).toContain(`frame-ancestors https://localhost:${port}`);
    expect((await get(port, host, '/__bfwc/relay.html', {}, 'POST')).status).toBe(405);
  });

  it('the host page: its document, bundle and stylesheet, and the database Worker script; framed by nobody', async () => {
    const { port } = await launch({ 'builderforce.json': NODE_MANIFEST });
    const page = `localhost:${port}`;
    const index = await get(port, page, '/');
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('/launcher/page.js');
    const csp = String(index.headers['content-security-policy']);
    expect(csp).toContain(`frame-src https://127.0.0.1:${port} https://*.localhost:${port}`);
    expect(csp).toContain(`connect-src 'self' https://cdn.jsdelivr.net https://esm.sh https://127.0.0.1:${port}/__bfwc/probe https://*.localhost:${port}/__bfwc/probe`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect((await get(port, page, '/launcher/page.js')).headers['content-type']).toContain('text/javascript');
    expect((await get(port, page, '/launcher/launcher.css')).headers['content-type']).toContain('text/css');
    expect((await get(port, page, '/__bfwc/process-worker.js')).status).toBe(200);
    expect((await get(port, page, '/__bfwc/sw.js')).status).toBe(404);
    expect((await get(port, page, '/launcher/page.js', { 'Service-Worker': 'script' })).status).toBe(403);
  });
});

describe('createLocalLauncher: close()', () => {
  it('frees the port', async () => {
    const project = tempProject({ 'builderforce.json': NODE_MANIFEST });
    cleanups.push(project.cleanup);
    const launcher = await createLocalLauncher({ projectDir: project.dir, tls: TLS });
    await launcher.close();
    await launcher.close(); // idempotent
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(launcher.port, '127.0.0.1', () => server.close(() => resolve()));
    });
  });
});
