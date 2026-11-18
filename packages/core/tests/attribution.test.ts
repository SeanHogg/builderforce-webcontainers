import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { injectAttribution, attributionFromMarker, ATTRIBUTION_URL, ATTRIBUTION_LABEL, ATTRIBUTION_OFF_MARKER } from '../src/attribution.js';
import { transformHtml } from '../src/html.js';
import { DevServer } from '../src/devServer.js';
import { VirtualFileSystem } from '../src/vfs.js';
import { createEsbuildTransformer } from '../src/transformer.js';

const text = (b: string | Uint8Array) => (typeof b === 'string' ? b : new TextDecoder().decode(b));

describe('attribution badge', () => {
  it('links to builderforce.ai with UTM tags and a shadow root', () => {
    const out = injectAttribution('<html><body><div></div></body></html>');
    expect(ATTRIBUTION_URL).toMatch(/^https:\/\/builderforce\.ai\/\?utm_source=webcontainers/);
    expect(out).toContain(JSON.stringify(ATTRIBUTION_URL));
    expect(out).toContain(JSON.stringify(ATTRIBUTION_LABEL));
    expect(out).toContain('attachShadow');
    expect(out.indexOf('bfwc-attribution')).toBeLessThan(out.lastIndexOf('</body>'));
  });

  it('appends to a fragment without a body', () => {
    expect(injectAttribution('<p>hi</p>').startsWith('<p>hi</p><script>')).toBe(true);
  });

  it('is on by default and off only when explicitly disabled', () => {
    expect(transformHtml('<body></body>', { base: '/p/' })).toContain('bfwc-attribution');
    expect(transformHtml('<body></body>', { base: '/p/', attribution: false })).not.toContain('bfwc-attribution');
  });

  it('flows through the dev server option', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'index.html': '<html><body></body></html>' });
    const make = (attribution?: boolean) =>
      new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', attribution });
    expect(text((await make().handle('/')).body)).toContain('bfwc-attribution');
    expect(text((await make(false).handle('/')).body)).not.toContain('bfwc-attribution');
  });

  it('asks a predicate on every page transformHtml renders', () => {
    expect(transformHtml('<body></body>', { base: '/p/', attribution: () => false })).not.toContain('bfwc-attribution');
    expect(transformHtml('<body></body>', { base: '/p/', attribution: () => true })).toContain('bfwc-attribution');
  });

  it('re-evaluates a predicate per dev-server response, for the document and cached .html pages alike', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'index.html': '<html><body></body></html>', 'about.html': '<html><body>about</body></html>' });
    let on = true;
    const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', attribution: () => on });
    expect(text((await server.handle('/')).body)).toContain('bfwc-attribution');
    expect(text((await server.handle('/about.html')).body)).toContain('bfwc-attribution');
    on = false;
    expect(text((await server.handle('/')).body)).not.toContain('bfwc-attribution');
    expect(text((await server.handle('/about.html')).body)).not.toContain('bfwc-attribution');
    on = true;
    expect(text((await server.handle('/about.html')).body)).toContain('bfwc-attribution');
  });

  it('follows the marker file, unless the host turned the badge off', () => {
    const fs = new VirtualFileSystem();
    const render = (option?: boolean) => transformHtml('<body></body>', { base: '/p/', attribution: attributionFromMarker(fs, option) });
    expect(render()).toContain('bfwc-attribution');
    fs.writeFile(ATTRIBUTION_OFF_MARKER, '');
    expect(render()).not.toContain('bfwc-attribution');
    fs.rm(ATTRIBUTION_OFF_MARKER);
    expect(render()).toContain('bfwc-attribution');
    expect(render(false)).not.toContain('bfwc-attribution');
  });

  it('honours attribution: false for a queried page (?import)', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'index.html': '<html><body></body></html>', 'about.html': '<html><body>about</body></html>' });
    const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', attribution: false });
    expect(text((await server.handle('/about.html', '?import')).body)).not.toContain('bfwc-attribution');
  });

  it('keeps the badge off when new preview scripts evict cached pages', async () => {
    const fs = new VirtualFileSystem();
    fs.writeTree({ 'index.html': '<html><body></body></html>', 'about.html': '<html><body>about</body></html>' });
    const server = new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', attribution: () => false });
    expect(text((await server.handle('/about.html')).body)).not.toContain('bfwc-attribution');
    server.setPreviewScripts(['window.x=1']);
    const page = text((await server.handle('/about.html')).body);
    expect(page).toContain('window.x=1');
    expect(page).not.toContain('bfwc-attribution');
  });
});
