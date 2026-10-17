import { describe, expect, it } from 'vitest';
import { COOKIE_MESSAGE_TYPE, SOCKET_MESSAGE_TYPE, bridgeInsertionPoint, previewCookieScript, previewSocketScript } from '../src/previewBridge.js';
import { transformHtml, ERROR_MESSAGE_TYPE } from '../src/html.js';

describe('bridgeInsertionPoint', () => {
  it('goes right after <head>, whatever its attributes', () => {
    const html = '<!doctype html><html lang="en"><head data-x="1"><title>t</title>';
    expect(bridgeInsertionPoint(html)).toBe(html.indexOf('<title>'));
  });

  it('waits for more bytes while <head> may still come', () => {
    expect(bridgeInsertionPoint('<!doctype html><html><he')).toBeUndefined();
    expect(bridgeInsertionPoint('<!doctype html><html><he', true)).toBe('<!doctype html><html>'.length);
  });

  it('falls back to after <html> or the doctype (never before it), else the start', () => {
    expect(bridgeInsertionPoint('<!DOCTYPE html><html><body>hi')).toBe('<!DOCTYPE html><html>'.length);
    expect(bridgeInsertionPoint('<!DOCTYPE html><body>hi')).toBe('<!DOCTYPE html>'.length);
    expect(bridgeInsertionPoint('<div>fragment</div>')).toBe(0);
    expect(bridgeInsertionPoint('plain text', true)).toBe(0);
  });
});

describe('preview bridge scripts', () => {
  it('are self-contained scripts that parse', () => {
    for (const script of [previewSocketScript(), previewCookieScript('a=1; b="</script>"')]) {
      const body = /^<script>([\s\S]*)<\/script>$/.exec(script)?.[1];
      expect(body).toBeDefined();
      expect(body).not.toMatch(/<\/script/i);
      expect(() => new Function(body!)).not.toThrow();
    }
    expect(previewSocketScript()).toContain(JSON.stringify(SOCKET_MESSAGE_TYPE));
    expect(previewCookieScript('')).toContain(JSON.stringify(COOKIE_MESSAGE_TYPE));
  });

  it('runs the WebSocket shim in dev-server documents, after the error bridge and before the app', () => {
    const out = transformHtml('<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>', { base: '/__bfwc/p1/' });
    const shim = out.indexOf(SOCKET_MESSAGE_TYPE);
    expect(shim).toBeGreaterThan(out.indexOf(ERROR_MESSAGE_TYPE));
    expect(shim).toBeLessThan(out.indexOf('src/main.tsx'));
  });
});
