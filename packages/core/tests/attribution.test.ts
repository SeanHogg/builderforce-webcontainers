import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { injectAttribution, ATTRIBUTION_URL, ATTRIBUTION_LABEL } from '../src/attribution.js';
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
    fs.mount({ 'index.html': '<html><body></body></html>' });
    const make = (attribution?: boolean) =>
      new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: '/p/', attribution });
    expect(text((await make().handle('/')).body)).toContain('bfwc-attribution');
    expect(text((await make(false).handle('/')).body)).not.toContain('bfwc-attribution');
  });
});
