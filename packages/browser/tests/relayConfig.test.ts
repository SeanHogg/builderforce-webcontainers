import { describe, expect, it } from 'vitest';
import { ATTACH, attachMessageOf, randomNonce } from '../src/protocol.js';
import { relayConfigOf, relayConfigUrl, relayServiceWorkerUrl } from '../src/relayConfig.js';

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

  it("replaces whatever configuration the shared relay URL carried when an application's relay is built from it", () => {
    const shared = relayConfigUrl(RELAY, { egress: ['https://workspace.example'], policy: 'workspace' });
    const app = relayConfigUrl(shared, { egress: ['https://app.example'] });
    expect(relayConfigOf(app)).toEqual({ egress: ['https://app.example'] });
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
