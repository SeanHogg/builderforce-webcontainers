import { describe, expect, it } from 'vitest';
import { CSP_VIOLATION_MESSAGE_TYPE, TIMING_MESSAGE_TYPE } from '@seanhogg/builderforce-webcontainers-core';
import { stampPreviewResponse } from '../src/previewCsp.js';
import { relayConfigOf, relayConfigUrl, relayServiceWorkerUrl } from '../src/relayConfig.js';
import { listenToPreview, type PreviewCspViolation, type PreviewTiming } from '../src/previewMessages.js';

const RELAY = 'https://k1.preview.example.com/__bfwc/relay.html';
const policy = "default-src 'self'";

describe("report-only mode (previewCspMode: 'report-only')", () => {
  it('stamps the policy as Content-Security-Policy-Report-Only and leaves the app’s enforced CSP alone', () => {
    const out = stampPreviewResponse({ 'Content-Security-Policy': "script-src 'self'", 'Content-Type': 'text/html' }, { policy, reportOnly: true });
    expect(out['content-security-policy-report-only']).toBe(policy);
    expect(out['Content-Security-Policy']).toBe("script-src 'self'");
    expect(out['content-security-policy']).toBeUndefined();
    expect(out['x-content-type-options']).toBe('nosniff');
    expect(out['origin-agent-cluster']).toBe('?1');
  });

  it('adds to a report-only policy the app already sent, as a further policy', () => {
    const out = stampPreviewResponse({ 'content-security-policy-report-only': "img-src 'self'" }, { policy, reportOnly: true });
    expect(out['content-security-policy-report-only']).toBe(`img-src 'self', ${policy}`);
  });

  it('enforces by default', () => {
    const out = stampPreviewResponse({}, { policy });
    expect(out['content-security-policy']).toBe(policy);
    expect(out['content-security-policy-report-only']).toBeUndefined();
  });

  it('travels host-side: relay URL → worker URL → the worker’s configuration, and nothing else turns it on', () => {
    const relay = relayConfigUrl(RELAY, { egress: ['https://esm.sh'], cspMode: 'report-only' });
    const worker = relayServiceWorkerUrl(relay);
    expect(new URL(worker).searchParams.get('csp')).toBe('report-only');
    expect(relayConfigOf(worker)).toEqual({ egress: ['https://esm.sh'], cspMode: 'report-only' });
    expect(relayConfigOf(relayServiceWorkerUrl(relayConfigUrl(RELAY, { cspMode: 'enforce' })))).toEqual({ egress: [] });
    expect(relayConfigOf(`${RELAY}?csp=off`)).toEqual({ egress: [] });
    // An application's relay URL built from the shared one carries only its own mode.
    expect(relayConfigOf(relayConfigUrl(relay, { egress: [] }))).toEqual({ egress: [] });
  });
});

function fakeWindow() {
  let handler: ((event: MessageEvent) => void) | undefined;
  return {
    addEventListener: (_type: string, listener: EventListener) => void (handler = listener as (event: MessageEvent) => void),
    removeEventListener: () => void (handler = undefined),
    post: (origin: string, data: unknown) => handler?.({ origin, data } as MessageEvent),
  };
}

describe('CSP violations and timings from the preview', () => {
  const href = 'https://preview.test/__bfwc/p1/index.html';

  it('reach onCspViolation re-checked: origin reduced again, malformed or foreign messages dropped', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/', 'n0nce');
    const seen: PreviewCspViolation[] = [];
    messages.onCspViolation((v) => seen.push(v));
    win.post('https://preview.test', { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'img-src', blockedOrigin: 'https://tile.openstreetmap.org/1/2/3.png', disposition: 'enforce', href, nonce: 'n0nce' });
    win.post('https://preview.test', { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'script-src', blockedOrigin: 'eval', disposition: 'report', href, nonce: 'n0nce' });
    win.post('https://preview.test', { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'img-src *', blockedOrigin: 'https://a.example', href, nonce: 'n0nce' });
    win.post('https://preview.test', { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'img-src', blockedOrigin: 'https://a.example', href, nonce: 'wrong' });
    win.post('https://evil.test', { type: CSP_VIOLATION_MESSAGE_TYPE, directive: 'img-src', blockedOrigin: 'https://a.example', href, nonce: 'n0nce' });
    expect(seen).toEqual([
      { directive: 'img-src', blockedOrigin: 'https://tile.openstreetmap.org', disposition: 'enforce' },
      { directive: 'script-src', blockedOrigin: 'eval', disposition: 'report' },
    ]);
  });

  it('reach onTiming entry by entry, checked and bounded per message', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    const seen: PreviewTiming[] = [];
    messages.onTiming((t) => seen.push(t));
    win.post('https://preview.test', {
      type: TIMING_MESSAGE_TYPE,
      href,
      entries: [
        { kind: 'resource', origin: 'https://esm.sh/react?x=1', initiator: 'script', durationMs: 12, status: 200, cached: true },
        { kind: 'resource', origin: 'javascript:alert(1)', initiator: 'script', durationMs: 1 },
        { kind: 'resource', origin: 'https://a.example', initiator: '<b>', durationMs: -5 },
        { kind: 'paint', startMs: 80, at: 1_700_000_000_000 },
        { kind: 'other' },
      ],
    });
    expect(seen).toEqual([
      { kind: 'resource', origin: 'https://esm.sh', initiator: 'script', durationMs: 12, status: 200, cached: true },
      { kind: 'paint', startMs: 80, at: 1_700_000_000_000 },
    ]);
    messages.dispose();
  });
});
