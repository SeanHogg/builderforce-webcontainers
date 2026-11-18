import { describe, expect, it } from 'vitest';
import { CSP_REPORT_GROUP, cspReportUrlOf, egressSources, narrowCookieDomain, previewDocumentPolicy, stampPreviewResponse } from '../src/previewCsp.js';
import { headerKey, headerKeys, withoutHeader } from '../src/shared/headers.js';
import { relayWorkerUrl } from '../src/relayWorker.js';

const EGRESS = ['https://api.example.com', 'wss://ws.example.com', 'https://*.cdn.example.com:8443'];
const HOST = 'k1.preview.example.com';

describe('the preview CSP', () => {
  it('limits every fetch directive to the preview origin and the host-configured egress, and never names /__bfwc/', () => {
    const e = EGRESS.join(' ');
    expect(previewDocumentPolicy(EGRESS, { host: HOST, report: true })).toBe(
      [
        `default-src 'self' ${e}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${e}`,
        `style-src 'self' 'unsafe-inline' blob: data: ${e}`,
        `img-src 'self' data: blob: ${e}`,
        `font-src 'self' data: ${e}`,
        `media-src 'self' data: blob: ${e}`,
        `connect-src 'self' ws://${HOST} wss://${HOST} blob: data: ${e}`,
        "frame-src 'self' blob:",
        `form-action 'self' ${e}`,
        "worker-src 'self' blob:",
        `report-to ${CSP_REPORT_GROUP}`,
      ].join('; '),
    );
    expect(previewDocumentPolicy(EGRESS)).not.toContain('/__bfwc/');
  });

  it("allows the dev server's WebSockets (Vite HMR) to its own host explicitly, not by how a browser reads 'self'", () => {
    const connect = previewDocumentPolicy([], { host: 'k1.preview.example.com:8443' })
      .split('; ')
      .find((directive) => directive.startsWith('connect-src '))!;
    expect(connect.split(' ')).toEqual(expect.arrayContaining(["'self'", 'ws://k1.preview.example.com:8443', 'wss://k1.preview.example.com:8443']));
    // No egress and no host: its own origin only, and no report-to without an endpoint.
    const bare = previewDocumentPolicy(undefined);
    expect(bare).toContain("connect-src 'self' blob: data:;");
    expect(bare).toContain("default-src 'self';");
    expect(bare).not.toContain('report-to');
    // A malformed host never reaches the policy.
    expect(previewDocumentPolicy([], { host: 'x; script-src *' })).not.toContain('script-src *');
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

  it('takes only an https report endpoint that is safe inside a header', () => {
    expect(cspReportUrlOf('https://api.example.com/csp-reports')).toBe('https://api.example.com/csp-reports');
    for (const bad of ['http://api.example.com/r', 'https://a.example/r", evil="https://x', 'https://a.example/r;x', 'not a url', 'https://u:p@a.example/', 7]) {
      expect(cspReportUrlOf(bad)).toBeUndefined();
    }
  });
});

describe('the stamp on every service-worker response', () => {
  const policy = previewDocumentPolicy(['https://api.example.com'], { host: HOST });
  const stamped = (headers: Record<string, string>) => stampPreviewResponse(headers, { policy, host: HOST });

  it('stamps a response with no Content-Type, an SVG, a script and a non-200 refusal alike', () => {
    for (const headers of <Array<Record<string, string>>>[{}, { 'content-type': 'image/svg+xml' }, { 'Content-Type': 'text/javascript' }, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }]) {
      const out = stamped(headers);
      expect(out['content-security-policy']).toBe(policy);
      expect(out['x-content-type-options']).toBe('nosniff');
      expect(out['origin-agent-cluster']).toBe('?1');
    }
  });

  it('adds the policy beside every CSP the app set (any spelling), never replacing or weakening it, and folds duplicate keys', () => {
    const out = stamped({
      'Content-Security-Policy': "default-src 'none'",
      'content-security-policy': "img-src 'none'",
      'content-type': 'application/xhtml+xml',
      'X-Content-Type-Options': 'off',
      'x-content-type-options': 'off',
    });
    expect(out).toEqual({
      'content-type': 'application/xhtml+xml',
      'content-security-policy': `default-src 'none', img-src 'none', ${policy}`,
      'x-content-type-options': 'nosniff',
      'origin-agent-cluster': '?1',
    });
    expect(headerKeys(out, 'content-security-policy')).toHaveLength(1);
  });

  it('names the report endpoint under its own group, after (so over) any the app defined', () => {
    const out = stampPreviewResponse({ 'Reporting-Endpoints': `${CSP_REPORT_GROUP}="https://evil.example/r"` }, { policy, reportUrl: 'https://api.example.com/csp' });
    expect(out['reporting-endpoints']).toBe(`${CSP_REPORT_GROUP}="https://evil.example/r", ${CSP_REPORT_GROUP}="https://api.example.com/csp"`);
    expect(stamped({})['reporting-endpoints']).toBeUndefined();
  });

  it("keeps a cookie host-only unless its Domain is the preview's exact host", () => {
    expect(narrowCookieDomain('sid=1; Path=/; Domain=preview.example.com; Secure', HOST)).toBe('sid=1; Path=/; Secure');
    expect(narrowCookieDomain('sid=1; domain=.example.com', HOST)).toBe('sid=1');
    expect(narrowCookieDomain(`sid=1; Domain=${HOST}`, HOST)).toBe(`sid=1; Domain=${HOST}`);
    expect(narrowCookieDomain(`sid=1; Domain=.${HOST.toUpperCase()}`, HOST)).toBe(`sid=1; Domain=.${HOST.toUpperCase()}`);
    expect(stamped({ 'Set-Cookie': 'a=1; Domain=preview.example.com', 'set-cookie': 'b=2' })['set-cookie']).toBe('a=1, b=2');
  });
});

describe('the one case-insensitive header helper', () => {
  it('finds every spelling of a header and removes them all', () => {
    const headers = { 'Content-Type': 'a', 'content-type': 'b', other: 'c' };
    expect(headerKeys(headers, 'CONTENT-TYPE')).toEqual(['Content-Type', 'content-type']);
    expect(headerKey(headers, 'content-type')).toBe('Content-Type');
    expect(headerKey(headers, 'missing')).toBeUndefined();
    expect(withoutHeader(headers, 'content-type')).toEqual({ other: 'c' });
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
