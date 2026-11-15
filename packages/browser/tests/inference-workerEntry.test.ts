/**
 * Phase 1 — worker entry composition-root test.
 *
 * `workerEntry.ts` is the bundled worker entry: on import it calls
 * `runInferenceWorker([createMockBackend()])`, which wires the backend list
 * into `startInferenceWorkerHost(globalThis, …)`. Under vitest the global is
 * Node's, not a WorkerGlobalScope, so we install a minimal
 * postMessage/addEventListener facade on `globalThis` before importing the
 * entry. That lets the entry's own wiring drive one end of an in-memory
 * MessageChannel while a real `InferenceClient` drives the other — asserting
 * the composed worker actually probes, loads, and generates, not merely that
 * the file parses.
 */

import { describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { createInferenceClient, type InferenceWorkerLike } from '../src/inference/client.js';
import type { ChatMessage, ModelRef } from '../src/inference/types.js';

/** Shape one MessageChannel port into the Worker-like the client expects. */
function workerLikeFromPort(port: import('node:worker_threads').MessagePort): InferenceWorkerLike {
  const w = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    postMessage: (data: unknown, _transfer?: Transferable[]) => port.postMessage(data),
    terminate: () => port.close(),
  };
  port.on('message', (data: unknown) => w.onmessage?.({ data }));
  return w;
}

describe('inference workerEntry', () => {
  it('composes a worker host that probes, loads, and generates', async () => {
    const channel = new MessageChannel();
    const listeners = new Set<(event: { data: unknown }) => void>();

    // Minimal WorkerGlobalScope facade so the entry's runInferenceWorker can
    // attach to globalThis. Outbound messages go to the host-side port.
    const g = globalThis as Record<string, unknown>;
    const originalPostMessage = g.postMessage;
    const originalAddEventListener = g.addEventListener;
    const originalRemoveEventListener = g.removeEventListener;
    g.postMessage = (message: unknown) => channel.port1.postMessage(message);
    g.addEventListener = (_type: string, listener: (event: { data: unknown }) => void) => {
      listeners.add(listener);
    };
    g.removeEventListener = (_type: string, listener: (event: { data: unknown }) => void) => {
      listeners.delete(listener);
    };
    // Deliver host→worker messages to every registered listener.
    channel.port1.on('message', (data: unknown) => {
      for (const listener of listeners) listener({ data });
    });

    try {
      // Importing workerEntry runs runInferenceWorker([createMockBackend()]).
      await import('../src/inference/workerEntry.js');

      const client = createInferenceClient({
        createWorker: () => workerLikeFromPort(channel.port2),
        cache: createMemoryCache(),
        fetchModel: async () => new TextEncoder().encode('weights').buffer as ArrayBuffer,
      });

      const caps = await client.probe();
      expect(typeof caps.wasm).toBe('boolean');

      const ref: ModelRef = { id: 'builderforce/tiny-instruct-q4', paramsB: 1.1, quantization: 'q4' };
      await client.load(ref);

      const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
      const gen = client.generate(messages, { maxTokens: 4 });
      const tokens: string[] = [];
      for await (const { token } of gen) tokens.push(token);
      expect(tokens.length).toBe(4);

      await client.dispose();
    } finally {
      if (originalPostMessage === undefined) delete g.postMessage;
      else g.postMessage = originalPostMessage;
      if (originalAddEventListener === undefined) delete g.addEventListener;
      else g.addEventListener = originalAddEventListener;
      if (originalRemoveEventListener === undefined) delete g.removeEventListener;
      else g.removeEventListener = originalRemoveEventListener;
      channel.port1.close();
      channel.port2.close();
    }
  });
});

/** Cache stub used where persistence is irrelevant. */
function createMemoryCache() {
  const map = new Map<string, ArrayBuffer>();
  return {
    get: async (id: string) =>
      map.has(id)
        ? { id, quantization: 'q4' as const, paramsB: 1, bytes: map.get(id)!, size: map.get(id)!.byteLength, storedAt: 0 }
        : undefined,
    put: async (id: string, entry: { bytes: ArrayBuffer }) => void map.set(id, entry.bytes.slice(0)),
    has: async (id: string) => map.has(id),
    delete: async (id: string) => void map.delete(id),
    keys: async () => [...map.keys()],
  };
}
