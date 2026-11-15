/**
 * Phase 1 integration test: host client <-> worker host comms, offline
 * behavior, and caching. Uses an in-memory MessageChannel pair instead of a
 * real Worker so it runs headless, with the real `startInferenceWorkerHost`
 * on one end and the real `createInferenceClient` on the other.
 */

import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createInferenceClient, type InferenceWorkerLike } from '../src/inference/client.js';
import { startInferenceWorkerHost } from '../src/inference/worker.js';
import { createMockBackend } from '../src/inference/backends/mock.js';
import { createModelCache } from '../src/inference/modelCache.js';
import { INFERENCE_LOAD } from '../src/inference/protocol.js';
import type { ChatMessage, ModelRef } from '../src/inference/types.js';

const encoder = new TextEncoder();

/** One end of a MessageChannel shaped like a Worker the client can drive. */
function workerLikeFromPort(port: MessagePort): InferenceWorkerLike {
  const w = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: { message?: string }) => void) | null,
    postMessage: (data: unknown, _transfer?: Transferable[]) => port.postMessage(data),
    terminate: () => port.close(),
  };
  port.onmessage = (event) => w.onmessage?.({ data: event.data });
  return w;
}

function wirePair() {
  const channel = new MessageChannel();
  const hostPort = channel.port1;
  const clientPort = channel.port2;
  startInferenceWorkerHost(
    {
      postMessage: (message) => hostPort.postMessage(message),
      addEventListener: (_t, listener) => {
        hostPort.onmessage = (e) => (listener as (event: { data: unknown }) => void)({ data: e.data });
      },
      removeEventListener: () => {},
    },
    { backends: [createMockBackend({ msPerToken: 1 })] },
  );
  return workerLikeFromPort(clientPort);
}

const ref: ModelRef = { id: 'builderforce/tiny-instruct-q4', paramsB: 1.1, quantization: 'q4' };
const messages: ChatMessage[] = [{ role: 'user', content: 'say something' }];

/** In-memory fetchModel for tests that don't care about provenance. */
const fakeWeights = async () => encoder.encode('weights').buffer as ArrayBuffer;

describe('inference client <-> worker host', () => {
  it('probes capabilities across the wire', async () => {
    const client = createInferenceClient({ createWorker: wirePair, cache: createModelCache({ indexedDB: new IDBFactory() }) });
    const caps = await client.probe();
    expect(typeof caps.wasm).toBe('boolean');
    await client.dispose();
  });

  it('loads a model and streams tokens, then reports stats', async () => {
    const client = createInferenceClient({ createWorker: wirePair, cache: createMemoryCache(), fetchModel: fakeWeights });
    await client.load(ref);
    const gen = client.generate(messages, { maxTokens: 5 });
    const tokens: string[] = [];
    for await (const { token, index } of gen) {
      tokens.push(token);
      expect(index).toBe(tokens.length - 1);
    }
    expect(tokens.length).toBe(5);
    const stats = await gen.stats;
    expect(stats.generatedTokens).toBe(5);
    expect(stats.tokensPerSecond).toBeGreaterThan(0);
    await client.dispose();
  });

  it('offline: after load, generate makes no network call', async () => {
    const cache = createMemoryCache();
    let fetches = 0;
    const fetchModel = async (r: ModelRef) => {
      fetches++;
      return encoder.encode('weights-' + r.id).buffer as ArrayBuffer;
    };
    const client = createInferenceClient({ createWorker: wirePair, cache, fetchModel });

    await client.load(ref); // cache miss → fetchModel called once, bytes cached
    expect(fetches).toBe(1);
    expect(await cache.has(ref.id)).toBe(true);

    // A fresh client over the SAME cache must not need the network.
    const offline = createInferenceClient({
      createWorker: wirePair,
      cache,
      fetchModel: async () => {
        throw new Error('network must not be used after provisioning');
      },
    });
    await offline.load(ref); // cache hit → fetchModel never called
    const gen = offline.generate(messages, { maxTokens: 3 });
    const tokens: string[] = [];
    for await (const { token } of gen) tokens.push(token);
    expect(tokens.length).toBe(3);
    await offline.dispose();
    await client.dispose();
  });

  it('transfers weights without detaching the cached copy (offline reloads work)', async () => {
    const cache = createMemoryCache();
    const client = createInferenceClient({ createWorker: wirePair, cache, fetchModel: async () => encoder.encode('w').buffer as ArrayBuffer });
    await client.load(ref);
    // Cached bytes must still be intact after the transfer to the worker.
    const entry = await cache.get(ref.id);
    expect(entry).toBeDefined();
    expect(entry!.bytes.byteLength).toBeGreaterThan(0);
    await client.dispose();
  });

  it('cancel stops a long generation', async () => {
    const client = createInferenceClient({ createWorker: wirePair, cache: createMemoryCache(), fetchModel: fakeWeights });
    await client.load(ref);
    const gen = client.generate(messages, { maxTokens: 1000 });
    const tokens: string[] = [];
    const pump = (async () => {
      for await (const { token } of gen) tokens.push(token);
    })();
    // Let a few tokens through, then cancel.
    await new Promise((r) => setTimeout(r, 20));
    client.cancel();
    await pump;
    expect(tokens.length).toBeLessThan(1000);
    await client.dispose();
  });

  it('surfaces worker errors instead of hanging', async () => {
    const portWorker = wirePair();
    const client = createInferenceClient({ createWorker: () => portWorker, cache: createMemoryCache() });
    const gen = client.generate(messages);
    // The worker replies with inference:error for a generate with no model
    // loaded; the async iterator must throw rather than end silently.
    await expect(gen[Symbol.asyncIterator]().next()).rejects.toThrow('no model loaded');
    await client.dispose();
  });
});

/** Cache stub used where persistence is irrelevant. */
function createMemoryCache() {
  const map = new Map<string, ArrayBuffer>();
  return {
    get: async (id: string) => (map.has(id) ? { id, quantization: 'q4', paramsB: 1, bytes: map.get(id)!, size: map.get(id)!.byteLength, storedAt: 0 } : undefined),
    put: async (id: string, entry: { bytes: ArrayBuffer }) => void map.set(id, entry.bytes.slice(0)),
    has: async (id: string) => map.has(id),
    delete: async (id: string) => void map.delete(id),
    keys: async () => [...map.keys()],
  };
}
