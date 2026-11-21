import { describe, expect, it } from 'vitest';
import { ATTACH, attachMessageOf, randomNonce } from '../src/protocol.js';
import { relayConfigOf, relayConfigUrl, relayServiceWorkerUrl, serviceWorkerRegistrationError } from '../src/relayConfig.js';
import { attachModeOf } from '../src/swBindings.js';

const RELAY = 'https://k1.preview.example.com/__bfwc/relay.html';

describe("the service worker's host-side configuration", () => {
  it('travels from the relay URL the host frames into the worker URL the relay registers, and is read back from it', () => {
    const relay = relayConfigUrl(RELAY, { egress: ['https://api.example.com', 'wss://ws.example.com'], policy: 'v1.signed-id', report: 'https://api.example.com/csp' });
    const worker = relayServiceWorkerUrl(relay);
    expect(new URL(worker).pathname).toBe('/__bfwc/sw.js');
    expect(new URL(worker).searchParams.get('mode')).toBe('relay');
    expect(relayConfigOf(worker)).toEqual({ egress: ['https://api.example.com', 'wss://ws.example.com'], policy: 'v1.signed-id', report: 'https://api.example.com/csp' });
  });

  it('carries nothing malformed: bad egress, policy ids and report URLs are dropped, never widened', () => {
    const relay = relayConfigUrl(RELAY, { egress: ['https://ok.example', '*', "'unsafe-eval'", 'https://a.example; script-src *'], policy: 'a b', report: 'http://plain.example/r' });
    expect(relayConfigOf(relayServiceWorkerUrl(relay))).toEqual({ egress: ['https://ok.example'] });
    // A worker URL forged with extra sources is still only ever read through the same checks.
    expect(relayConfigOf(`${RELAY}?egress=*%20https://ok.example%20'self'`)).toEqual({ egress: ['https://ok.example'] });
    expect(relayConfigOf('not a url')).toEqual({ egress: [] });
  });

  it('regression: reads a URL that names any query key twice as malformed, carrying nothing', () => {
    const worker = relayServiceWorkerUrl(relayConfigUrl(RELAY, { egress: ['https://ok.example'], policy: 'v1.signed-id', report: 'https://ok.example/csp', cspMode: 'report-only' }));
    expect(relayConfigOf(worker)).toMatchObject({ policy: 'v1.signed-id', cspMode: 'report-only' });
    for (const repeat of ['egress=https://evil.example', 'policy=other', 'report=https://evil.example/r', 'csp=report-only', 'mode=relay', 'x=1&x=2']) {
      expect(relayConfigOf(`${worker}&${repeat}`)).toEqual({ egress: [] });
    }
    expect(relayConfigOf(`${RELAY}?csp=report-only&csp=report-only`)).toEqual({ egress: [] });
    // The worker's attach mode: a repeated `mode` gets the stricter relay rule.
    expect(attachModeOf('https://k1.preview.example.com/__bfwc/sw.js?mode=relay')).toBe('relay');
    expect(attachModeOf('https://k1.preview.example.com/__bfwc/sw.js?mode=same-origin&mode=relay')).toBe('relay');
    expect(attachModeOf('https://k1.preview.example.com/__bfwc/sw.js?mode=x&mode=y')).toBe('relay');
    expect(attachModeOf('https://example.com/sw.js')).toBe('same-origin');
  });

  it("replaces whatever configuration the shared relay URL carried when an application's relay is built from it", () => {
    const shared = relayConfigUrl(RELAY, { egress: ['https://workspace.example'], policy: 'workspace' });
    const app = relayConfigUrl(shared, { egress: ['https://app.example'] });
    expect(relayConfigOf(app)).toEqual({ egress: ['https://app.example'] });
  });

  it('a failed registration names the configuration the gate may have refused, the CDN origins included', () => {
    const worker = relayServiceWorkerUrl(relayConfigUrl(RELAY, { egress: ['https://cdn.example.com', 'https://api.example.com'], policy: 'v1.signed-id' }));
    const error = serviceWorkerRegistrationError(worker, new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (403) was received.'));
    expect(error.message).toContain('https://k1.preview.example.com/__bfwc/sw.js');
    expect(error.message).toContain('403');
    expect(error.message).toContain('egress: https://cdn.example.com https://api.example.com');
    expect(error.message).toContain('policy: v1.signed-id');
    expect(error.message).toContain("custom `cdn`'s origins");
    expect(error.message).not.toContain('?'); // the URL is named without its query
    expect(serviceWorkerRegistrationError('not a url', 'boom').message).toContain('egress: none');
  });
});

describe('an attach message', () => {
  it('never carries egress (or anything beside the id and its proof), whatever the message it is built from says', () => {
    const nonce = randomNonce();
    const forged = { id: 'p1', nonce, previous: undefined, egress: ['https://evil.example'], report: 'https://evil.example/r' } as { id: string; nonce: string };
    expect(attachMessageOf(forged)).toEqual({ type: ATTACH, id: 'p1', nonce });
    const previous = randomNonce();
    expect(attachMessageOf({ id: 'p1', nonce, previous })).toEqual({ type: ATTACH, id: 'p1', nonce, previous });
  });
});
