import { describe, expect, it } from 'vitest';
import { egressSources, isDocumentResponse, previewDocumentPolicy, stampPreviewCsp } from '../src/previewCsp.js';
import { relayWorkerUrl } from '../src/relayWorker.js';

describe('the preview document CSP', () => {
  it("limits connect-src to the preview's own origin and its declared egress, and never names /__bfwc/", () => {
    const policy = previewDocumentPolicy(['https://api.example.com', 'wss://ws.example.com', 'https://*.cdn.example.com:8443']);
    expect(policy).toBe("connect-src 'self' blob: data: https://api.example.com wss://ws.example.com https://*.cdn.example.com:8443; worker-src 'self' blob:");
    expect(previewDocumentPolicy(undefined)).toBe("connect-src 'self' blob: data:; worker-src 'self' blob:");
    expect(policy).not.toContain('/__bfwc/');
  });

  it('drops anything that is not a bare https/wss source, so egress can never widen or inject the policy', () => {
    expect(
      egressSources([
        'https://ok.example',
        'https://ok.example',
        'https://x.example/__bfwc/',
        'http://plain.example',
        '*',
        'https://*',
        "'unsafe-eval'",
        'https://a.example; script-src *',
        'https://a.example, default-src *',
        'https://a.example b.example',
        42,
      ]),
    ).toEqual(['https://ok.example']);
    expect(egressSources('https://ok.example')).toEqual([]);
    expect(egressSources(Array.from({ length: 100 }, (_, i) => `https://h${i}.example`))).toHaveLength(64);
  });

  it('stamps only documents', () => {
    expect(isDocumentResponse({ 'Content-Type': 'text/html; charset=utf-8' })).toBe(true);
    expect(isDocumentResponse({ 'content-type': 'application/xhtml+xml' })).toBe(true);
    expect(isDocumentResponse({ 'content-type': 'text/javascript' })).toBe(false);
    expect(isDocumentResponse({})).toBe(false);
  });

  it("adds the policy beside the app's own CSP, never replacing or weakening it", () => {
    const ours = previewDocumentPolicy([]);
    expect(stampPreviewCsp({ 'content-type': 'text/html' }, ours)).toEqual({ 'content-type': 'text/html', 'content-security-policy': ours });
    const stamped = stampPreviewCsp({ 'Content-Security-Policy': "default-src 'none'", 'content-type': 'text/html' }, ours);
    expect(stamped).toEqual({ 'content-type': 'text/html', 'content-security-policy': `default-src 'none', ${ours}` });
  });
});

describe('the egress policy id on process Worker scripts', () => {
  const relay = 'https://k.preview.example.com/__bfwc/relay.html';

  it('carries a well-formed id as ?policy=, beside the relay', () => {
    const script = relayWorkerUrl('python', 'v1.abc-DEF_~', relay);
    expect(script.url.href).toBe('https://k.preview.example.com/__bfwc/python-worker.js?policy=v1.abc-DEF_~');
    expect(script.name).toBe('bfwc-python');
  });

  it('leaves a missing or malformed id off: the most restrictive policy', () => {
    for (const policy of [undefined, '', 'a b', 'x&policy=other', 'x'.repeat(513), 7]) {
      expect(relayWorkerUrl('node', policy, relay).url.href).toBe('https://k.preview.example.com/__bfwc/process-worker.js');
    }
  });
});
