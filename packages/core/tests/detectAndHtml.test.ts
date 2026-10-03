import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '../src/vfs.js';
import { detectProject } from '../src/detectProject.js';
import { transformHtml, reloadChannelName, ERROR_MESSAGE_TYPE } from '../src/html.js';

function project(files: Record<string, string>): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.mount(files);
  return fs;
}

describe('detectProject', () => {
  it('recognises a Vite app', () => {
    const p = detectProject(project({ 'index.html': '', 'package.json': '{"devDependencies":{"vite":"^5"}}' }));
    expect(p).toMatchObject({ supported: true, kind: 'vite', htmlPath: '/index.html' });
  });

  it('recognises Create React App and finds its entry', () => {
    const p = detectProject(project({ 'public/index.html': '', 'src/index.js': '', 'package.json': '{}' }));
    expect(p).toMatchObject({ supported: true, kind: 'cra', htmlPath: '/public/index.html', entry: '/src/index.js' });
  });

  it('declines frameworks that need Node, with a reason', () => {
    const next = detectProject(project({ 'package.json': '{"dependencies":{"next":"14"}}', 'index.html': '' }));
    expect(next.supported).toBe(false);
    expect(next.reason).toMatch(/Next\.js/);
    const server = detectProject(project({ 'package.json': '{"dependencies":{"express":"4"}}', 'server.js': '' }));
    expect(server).toMatchObject({ supported: false });
  });

  it('declines a project with no HTML entry', () => {
    expect(detectProject(project({ 'src/a.ts': '' }))).toMatchObject({ supported: false });
  });
});

describe('transformHtml', () => {
  it('listens for live reload on a channel keyed by its own preview base', () => {
    const out = transformHtml('<html><head></head><body></body></html>', { base: '/__bfwc/p/a/' });
    expect(out).toContain(JSON.stringify(reloadChannelName('/__bfwc/p/a/')));
    expect(reloadChannelName('/__bfwc/p/a/')).not.toBe(reloadChannelName('/__bfwc/p/b/'));
  });

  const base = '/__bfwc/p1/';

  it('re-roots absolute paths and injects the error bridge first', () => {
    const html = '<html><head><link href="/favicon.svg"></head><body><script type="module" src="/src/main.tsx"></script></body></html>';
    const out = transformHtml(html, { base });
    expect(out).toContain('href="/__bfwc/p1/favicon.svg"');
    expect(out).toContain('src="/__bfwc/p1/src/main.tsx"');
    expect(out.indexOf(ERROR_MESSAGE_TYPE)).toBeLessThan(out.indexOf('src/main.tsx'));
  });

  it('leaves protocol-relative and external URLs alone', () => {
    const out = transformHtml('<script src="//cdn.x/a.js"></script><img src="https://x/y.png">', { base });
    expect(out).toContain('src="//cdn.x/a.js"');
    expect(out).toContain('src="https://x/y.png"');
  });

  it('fills %PUBLIC_URL% and injects the CRA entry', () => {
    const out = transformHtml('<head><link href="%PUBLIC_URL%/logo.png"></head><body><div id="root"></div></body>', { base, entry: '/src/index.js' });
    expect(out).toContain('href="/__bfwc/p1/logo.png"');
    expect(out).toContain('<script type="module" src="/__bfwc/p1/src/index.js"></script>');
    expect(out.indexOf('src/index.js')).toBeLessThan(out.lastIndexOf('</body>'));
  });
});
