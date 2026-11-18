import { describe, expect, it, vi } from 'vitest';
import { PortCookieJars } from '@seanhogg/builderforce-webcontainers-core';
import { attachPreview } from '../src/previewAttach.js';
import { ATTACH_NONCE, type AttachProof, type WireResponse } from '../src/protocol.js';
import type { PreviewTransport } from '../src/transport.js';
import { host } from './helpers.js';

/** A transport that keeps what each attach handed the worker. */
function recordingTransport() {
  const attaches: Array<{ id: string; port: MessagePort; proof: AttachProof; egress?: readonly string[] }> = [];
  let reattach: ((id: string) => void) | undefined;
  const transport: PreviewTransport = {
    origin: 'https://k.preview.test',
    scope: '/__bfwc/',
    attach: (id, port, proof, egress) => void attaches.push({ id, port, proof, egress }),
    onReattach(listener) {
      reattach = listener;
      return () => (reattach = undefined);
    },
    send: vi.fn(),
    dispose: vi.fn(),
  };
  return { transport, attaches, reattach: (id: string) => reattach?.(id) };
}

/** Send one wire request over the worker's end of an attach and wait for the answer. */
function ask(port: MessagePort, path: string): Promise<WireResponse> {
  return new Promise((resolve) => {
    port.onmessage = (event) => resolve(event.data as WireResponse);
    port.postMessage({ type: 'request', reqId: 1, path, search: '', method: 'GET', headers: {}, body: null });
  });
}

describe('attaching a preview', () => {
  it('mints a fresh nonce per attach, chained to the last, and passes the declared egress', () => {
    const { processes } = host();
    const { transport, attaches, reattach } = recordingTransport();
    const stop = attachPreview({ transport, id: 'p1', processes, cookies: new PortCookieJars(), scripts: () => [], bridgeNonce: 'b', egress: ['https://api.test'], mayServePort: () => true });
    reattach('other');
    reattach('p1');
    expect(attaches).toHaveLength(2);
    const [first, second] = attaches;
    expect(first!.proof.nonce).toMatch(ATTACH_NONCE);
    expect(first!.proof.previous).toBeUndefined();
    expect(second!.proof).toEqual({ nonce: expect.stringMatching(ATTACH_NONCE), previous: first!.proof.nonce });
    expect(second!.proof.nonce).not.toBe(first!.proof.nonce);
    expect(first!.egress).toEqual(['https://api.test']);
    stop();
    reattach('p1');
    expect(attaches).toHaveLength(2);
    processes.dispose();
  });

  it("refuses, on the page, a port this origin may not reach and the dev server on an application's origin", async () => {
    const { processes } = host();
    const { transport, attaches } = recordingTransport();
    const refused: Array<number | undefined> = [];
    const stop = attachPreview({
      transport,
      id: 'p1',
      processes,
      cookies: new PortCookieJars(),
      scripts: () => [],
      bridgeNonce: 'b',
      mayServePort: (port) => port === 3000,
      onRefused: (port) => refused.push(port),
    });
    const worker = attaches[0]!.port;
    expect((await ask(worker, '/__port/4000/')).status).toBe(403);
    expect((await ask(worker, '/index.html')).status).toBe(403); // no dev server here
    expect((await ask(worker, '/__port/3000/')).status).toBe(502); // allowed: nothing listens
    expect(refused).toEqual([4000, undefined]);
    worker.close();
    stop();
    processes.dispose();
  });
});
