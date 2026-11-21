/**
 * The service worker's side of an attached preview, for tests that drive
 * `attachPreview` without a browser: a transport keeping each attach's worker
 * end, that end (the ingress tables the host sent, and wire requests), and a
 * streamed answer's body.
 */
import { vi } from 'vitest';
import type { AttachProof, RequestOrigin, WireIngress, WireResponse } from '../src/protocol.js';
import type { PreviewTransport } from '../src/transport.js';

/** What one attach handed the worker. */
export interface RecordedAttach {
  id: string;
  port: MessagePort;
  proof: AttachProof;
  /** Anything passed beyond the proof (an attach hands the worker nothing more). */
  extra: unknown[];
}

/** A transport keeping what each attach handed the worker (`attaches`), and each attach's worker end (`ports`). */
export function recordingTransport(origin = 'https://app.preview.test') {
  const attaches: RecordedAttach[] = [];
  /** Each attach's worker end, in order: `attaches[i].port` (kept as an array so it can be destructured before attaching). */
  const ports: MessagePort[] = [];
  let reattach: ((id: string) => void) | undefined;
  const transport: PreviewTransport = {
    origin,
    scope: '/__bfwc/',
    attach(id, port, proof, ...extra: unknown[]) {
      attaches.push({ id, port, proof, extra });
      ports.push(port);
    },
    onReattach(listener) {
      reattach = listener;
      return () => (reattach = undefined);
    },
    send: vi.fn(),
    dispose: vi.fn(),
  };
  return { transport, attaches, ports, reattach: (id: string) => reattach?.(id) };
}

/** The worker end: every message the host posts, and a request/answer helper. */
export function workerEnd(port: MessagePort) {
  const tables: WireIngress[] = [];
  let answer: ((response: WireResponse) => void) | undefined;
  port.onmessage = (event) => {
    const data = event.data as { type: string };
    if (data.type === 'ingress') tables.push(data as WireIngress);
    else if (data.type === 'response') answer?.(data as WireResponse);
  };
  let reqId = 0;
  const ask = (path: string, from?: RequestOrigin, search = '') =>
    new Promise<WireResponse>((resolve) => {
      answer = resolve;
      port.postMessage({ type: 'request', reqId: ++reqId, path, search, method: 'GET', headers: {}, body: null, ...(from ? { from } : {}) });
    });
  return { tables, ask };
}

const bodyText = (response: WireResponse) => (typeof response.body === 'string' ? response.body : '');

/** A streamed answer's body, gathered from its chunks. */
export function streamed(port: MessagePort, response: WireResponse): Promise<string> {
  if (!response.streaming) return Promise.resolve(bodyText(response));
  return new Promise((resolve) => {
    let text = '';
    const decoder = new TextDecoder();
    const previous = port.onmessage;
    port.onmessage = (event) => {
      const data = event.data as { type: string; data?: ArrayBuffer };
      if (data.type === 'chunk') text += decoder.decode(data.data, { stream: true });
      else if (data.type === 'end') {
        port.onmessage = previous;
        resolve(text + decoder.decode());
      }
    };
  });
}
