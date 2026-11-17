/**
 * InferenceClient request lifecycle against a scripted fake worker: what is
 * posted (no AbortSignal on the wire, the transferred buffer is the one in the
 * message), how cancellation is signalled, and that a crashed worker fails
 * every waiter and every later call instead of hanging.
 */

import { describe, expect, it } from 'vitest';
import { createInferenceClient, type InferenceWorkerLike } from '../src/inference/client.js';
import { createMemoryModelCache } from '../src/inference/modelCache.js';
import {
  INFERENCE_CANCEL,
  INFERENCE_DONE,
  INFERENCE_GENERATE,
  INFERENCE_LOAD,
  INFERENCE_READY,
  INFERENCE_TOKEN,
} from '../src/inference/protocol.js';
import type { ChatMessage, ModelRef } from '../src/inference/types.js';

interface Posted {
  message: Record<string, unknown>;
  transfer?: Transferable[];
}

function fakeWorker() {
  const posted: Posted[] = [];
  const w: InferenceWorkerLike & { posted: Posted[]; emit(data: unknown): void; crash(message: string): void } = {
    posted,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      // Mirror the real structured-clone rule the client must respect.
      structuredClone(message);
      posted.push({ message: message as Record<string, unknown>, transfer });
    },
    terminate() {},
    emit(data) {
      w.onmessage?.({ data });
    },
    crash(message) {
      w.onerror?.({ message });
    },
  };
  return w;
}

const ref: ModelRef = { id: 'm', paramsB: 1, quantization: 'q4' };
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('InferenceClient lifecycle', () => {
  it('never posts the AbortSignal and turns its abort into a cancel for that request', async () => {
    const w = fakeWorker();
    const client = createInferenceClient({ createWorker: () => w, cache: createMemoryModelCache() });
    const controller = new AbortController();
    const gen = client.generate(messages, { maxTokens: 3, signal: controller.signal });
    const sent = w.posted.find((p) => p.message.type === INFERENCE_GENERATE)!;
    expect(sent).toBeDefined();
    expect('signal' in (sent.message.options as object)).toBe(false);
    expect((sent.message.options as { maxTokens: number }).maxTokens).toBe(3);

    controller.abort();
    const cancel = w.posted.find((p) => p.message.type === INFERENCE_CANCEL);
    expect(cancel?.message.requestId).toBe(sent.message.id);

    w.emit({ type: INFERENCE_DONE, id: sent.message.id, requestId: sent.message.id, promptTokens: 1, promptTokensEstimated: true, generatedTokens: 0, ttftMs: 0, decodeMs: 0, tokensPerSecond: 0 });
    const tokens: string[] = [];
    for await (const { token } of gen) tokens.push(token);
    expect(tokens).toEqual([]);
    expect((await gen.stats).promptTokensEstimated).toBe(true);
  });

  it('breaking out of the iterator sends a cancel for that request', async () => {
    const w = fakeWorker();
    const client = createInferenceClient({ createWorker: () => w, cache: createMemoryModelCache() });
    const gen = client.generate(messages);
    const id = w.posted.find((p) => p.message.type === INFERENCE_GENERATE)!.message.id;
    w.emit({ type: INFERENCE_TOKEN, id, requestId: id, token: 'a', index: 0 });
    w.emit({ type: INFERENCE_TOKEN, id, requestId: id, token: 'b', index: 1 });
    for await (const t of gen) {
      expect(t.token).toBe('a');
      break;
    }
    const cancel = w.posted.find((p) => p.message.type === INFERENCE_CANCEL);
    expect(cancel?.message.requestId).toBe(id);
  });

  it('a worker crash rejects the waiting iterator and every later call immediately', async () => {
    const w = fakeWorker();
    const client = createInferenceClient({ createWorker: () => w, cache: createMemoryModelCache() });
    const gen = client.generate(messages);
    const next = gen[Symbol.asyncIterator]().next();
    await tick();
    w.crash('boom');
    await expect(next).rejects.toThrow('boom');
    await expect(gen.stats).rejects.toThrow('boom');

    const posts = w.posted.length;
    const later = client.generate(messages);
    await expect(later[Symbol.asyncIterator]().next()).rejects.toThrow('boom');
    expect(w.posted.length).toBe(posts);
    await expect(client.probe()).rejects.toThrow('boom');
  });

  it('load transfers the buffer that is in the message, copying nothing itself', async () => {
    const w = fakeWorker();
    const fetched = new TextEncoder().encode('weights').buffer as ArrayBuffer;
    const cache = createMemoryModelCache();
    const client = createInferenceClient({ createWorker: () => w, cache, fetchModel: async () => fetched });
    const loading = client.load(ref);
    await tick();
    await tick();
    const load = w.posted.find((p) => p.message.type === INFERENCE_LOAD)!;
    expect(load.message.weights).toBe(fetched);
    expect(load.transfer).toEqual([fetched]);
    w.emit({ type: INFERENCE_READY, id: load.message.id, capabilities: {} });
    await loading;
    // The cache kept its own copy, so a transfer cannot detach it.
    expect((await cache.get(ref.id))!.bytes.byteLength).toBe(fetched.byteLength);
  });

  it('still loads the model when the cache write rejects (e.g. a quota abort)', async () => {
    const w = fakeWorker();
    const fetched = new TextEncoder().encode('weights').buffer as ArrayBuffer;
    const logs: string[] = [];
    const cache = {
      ...createMemoryModelCache(),
      put: () => Promise.reject(new DOMException('quota', 'QuotaExceededError')),
    };
    const client = createInferenceClient({
      createWorker: () => w,
      cache,
      fetchModel: async () => fetched,
      logger: (m) => logs.push(m),
    });
    const loading = client.load(ref);
    await tick();
    await tick();
    const load = w.posted.find((p) => p.message.type === INFERENCE_LOAD)!;
    expect(load).toBeDefined();
    expect(load.message.weights).toBe(fetched);
    w.emit({ type: INFERENCE_READY, id: load.message.id, capabilities: {} });
    await expect(loading).resolves.toBeUndefined();
    expect(logs.some((m) => m.includes('model cache write failed') && m.includes(ref.id))).toBe(true);
  });
});
