import { describe, expect, it, vi } from 'vitest';
import { PortCookieJars } from '@seanhogg/builderforce-webcontainers-core';
import { attachPreview } from '../src/previewAttach.js';
import { ATTACH_NONCE, type AttachProof, type WireResponse } from '../src/protocol.js';
import type { PreviewTransport } from '../src/transport.js';
import { host } from './helpers.js';

/** A transport that keeps what each attach handed the worker. */
function recordingTransport() {
  const attaches: Array<{ id: string; port: MessagePort; proof: AttachProof; extra: unknown[] }> = [];
  let reattach: ((id: string) => void) | undefined;
  const transport: PreviewTransport = {
    origin: 'https://k.preview.test',
    scope: '/__bfwc/',
    attach: (id, port, proof, ...extra: unknown[]) => void attaches.push({ id, port, proof, extra }),
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
  it("mints a fresh nonce per attach, chained to the last one the worker acknowledged, and hands the worker no egress", async () => {
    const { processes } = host();
    const { transport, attaches, reattach } = recordingTransport();
    const stop = attachPreview({ transport, id: 'p1', processes, cookies: new PortCookieJars(), scripts: () => [], bridgeNonce: 'b', egress: ['https://api.test'], mayServePort: () => true });
    const acknowledge = async (index: number) => {
      attaches[index]!.port.postMessage({ type: 'attached', nonce: attaches[index]!.proof.nonce });
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    await acknowledge(0);
    reattach('other');
    reattach('p1');
    expect(attaches).toHaveLength(2);
    const [first, second] = attaches;
    expect(first!.proof.nonce).toMatch(ATTACH_NONCE);
    expect(first!.proof.previous).toBeUndefined();
    expect(second!.proof).toEqual({ nonce: expect.stringMatching(ATTACH_NONCE), previous: first!.proof.nonce });
    expect(second!.proof.nonce).not.toBe(first!.proof.nonce);
    // Egress is the worker's own configuration: nothing beside the proof goes with an attach.
    expect(attaches.every((attach) => attach.extra.length === 0 && !('egress' in attach.proof))).toBe(true);
    stop();
    reattach('p1');
    expect(attaches).toHaveLength(2);
    processes.dispose();
  });

  it('keeps chaining from the last acknowledged nonce when an attach is dropped, and ignores a superseded acknowledgement', async () => {
    const { processes } = host();
    const { transport, attaches, reattach } = recordingTransport();
    const stop = attachPreview({ transport, id: 'p1', processes, cookies: new PortCookieJars(), scripts: () => [], bridgeNonce: 'b', mayServePort: () => true });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    attaches[0]!.port.postMessage({ type: 'attached', nonce: attaches[0]!.proof.nonce });
    await tick();
    reattach('p1'); // this attach never reaches the worker: no acknowledgement
    reattach('p1');
    expect(attaches[2]!.proof.previous).toBe(attaches[0]!.proof.nonce);
    // A late acknowledgement on a channel already replaced does not move the chain.
    attaches[1]!.port.postMessage({ type: 'attached', nonce: attaches[1]!.proof.nonce });
    await tick();
    reattach('p1');
    expect(attaches[3]!.proof.previous).toBe(attaches[0]!.proof.nonce);
    // A forged acknowledgement (wrong nonce) on the current channel does not either.
    attaches[3]!.port.postMessage({ type: 'attached', nonce: '0'.repeat(32) });
    await tick();
    reattach('p1');
    expect(attaches[4]!.proof.previous).toBe(attaches[0]!.proof.nonce);
    stop();
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
