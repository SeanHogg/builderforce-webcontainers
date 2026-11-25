import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { detectProject } from '../src/detectProject.js';
import { DevServer } from '../src/devServer.js';
import { PUBLIC_DIR } from '../src/staticDirs.js';
import { createEsbuildTransformer } from '../src/transformer.js';
import { VirtualFileSystem } from '../src/vfs.js';

const text = (body: string | Uint8Array) => (typeof body === 'string' ? body : new TextDecoder().decode(body));

function project(files: Record<string, string>): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return fs;
}

describe('detectProject with a page', () => {
  it('serves a lone HTML file as a static project, with no index.html', () => {
    const fs = project({ 'mockup.html': '<html><body>mock</body></html>' });
    expect(detectProject(fs).supported).toBe(false);
    expect(detectProject(fs, { page: '/mockup.html' })).toEqual({ supported: true, kind: 'static', htmlPath: '/mockup.html', staticDirs: PUBLIC_DIR });
  });

  it('prefers the page over index.html', () => {
    const fs = project({ 'index.html': '<p>index</p>', 'mockup.html': '<p>mock</p>' });
    expect(detectProject(fs, { page: '/mockup.html' }).htmlPath).toBe('/mockup.html');
  });

  it('is unsupported, with the reason, when the page is not a file here — never falling back to index.html', () => {
    const fs = project({ 'index.html': '<p>index</p>' });
    const profile = detectProject(fs, { page: '/gone.html' });
    expect(profile).toMatchObject({ supported: false });
    expect(profile.htmlPath).toBeUndefined();
    expect(profile.reason).toContain('/gone.html');
  });

  it('the dev server serves the page at / with its sibling files beside it', async () => {
    const fs = project({ 'mockup.html': '<html><body>mock</body></html>', 'mockup.css': 'body{color:red}' });
    const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', page: '/mockup.html' });
    expect(text((await server.handle('/')).body)).toContain('mock');
    expect(text((await server.handle('/mockup.css')).body)).toContain('color:red');
  });
});
