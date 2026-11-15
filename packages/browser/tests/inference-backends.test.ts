import { describe, expect, it } from 'vitest';
import { createMockBackend, MOCK_VOCAB } from '../src/inference/backends/mock.js';
import { createOnnxBackend } from '../src/inference/backends/onnx.js';
import { createWllamaBackend } from '../src/inference/backends/wllama.js';
import { createWebLlmBackend } from '../src/inference/backends/webllm.js';
import { renderChatPrompt } from '../src/inference/backends/onnx.js';
import type { BackendContext, ChatMessage } from '../src/inference/types.js';

const noopContext: BackendContext = {
  log: () => {},
  sharedArrayBuffer: false,
  wasmSimd: false,
  webgpu: false,
};

const ref = { id: 'test/model-q4', paramsB: 1.1, quantization: 'q4' as const };
const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

describe('mock backend', () => {
  it('generates a deterministic token stream honoring maxTokens', async () => {
    const backend = createMockBackend({ msPerToken: 0, seed: 1 });
    await backend.load(ref, new ArrayBuffer(8), noopContext);
    const collect = async (b: typeof backend) => {
      const out: string[] = [];
      for await (const { token } of b.generate(messages, { maxTokens: 6 })) out.push(token);
      return out;
    };
    const first = await collect(backend);
    expect(first).toHaveLength(6);
    expect(first.every((t) => MOCK_VOCAB.includes(t))).toBe(true);
    expect(await collect(backend)).toEqual(first); // deterministic
  });

  it('stops early when the abort signal fires', async () => {
    const backend = createMockBackend({ msPerToken: 5 });
    await backend.load(ref, new ArrayBuffer(8), noopContext);
    const controller = new AbortController();
    const out: string[] = [];
    setTimeout(() => controller.abort(), 20);
    for await (const { token } of backend.generate(messages, { maxTokens: 100, signal: controller.signal })) {
      out.push(token);
    }
    expect(out.length).toBeLessThan(100);
  });

  it('probe reports available', async () => {
    const info = await createMockBackend().probe();
    expect(info.available).toBe(true);
    expect(info.kind).toBe('mock');
  });
});

describe('onnx backend (injected module)', () => {
  it('loads and streams tokens through the injected wasm module', async () => {
    const streamed: string[] = [];
    const backend = createOnnxBackend({
      loadModule: async () => ({
        initRuntime: async () => {},
        createSession: async () => ({
          async *run() {
            for (const t of ['a', 'b', 'c']) {
              streamed.push(t);
              yield t;
            }
          },
          release: async () => {},
        }),
      }),
    });
    await backend.load(ref, new ArrayBuffer(8), noopContext);
    const out: string[] = [];
    for await (const { token } of backend.generate(messages, { maxTokens: 3 })) out.push(token);
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('reports WebAssembly availability in probe', async () => {
    const info = await createOnnxBackend({ loadModule: async () => { throw new Error('unused'); } }).probe();
    expect(info.kind).toBe('onnx');
    expect(typeof info.available).toBe('boolean');
    expect(typeof info.wasmSimd).toBe('boolean');
  });
});

describe('wllama + webllm adapters', () => {
  it('wllama streams through the injected module', async () => {
    const backend = createWllamaBackend({
      loadModule: async () => ({
        init: async () => {},
        loadModel: async () => ({
          async *generate() {
            yield 'x';
            yield 'y';
          },
          release: async () => {},
        }),
      }),
    });
    await backend.load(ref, new ArrayBuffer(8), noopContext);
    const out: string[] = [];
    for await (const { token } of backend.generate(messages)) out.push(token);
    expect(out).toEqual(['x', 'y']);
  });

  it('webllm reports unavailable without WebGPU', async () => {
    const info = await createWebLlmBackend({ loadModule: async () => { throw new Error('unused'); } }).probe();
    expect(info.kind).toBe('webllm');
    expect(info.webgpu).toBe(false);
    expect(info.available).toBe(false);
  });
});

describe('renderChatPrompt', () => {
  it('formats chat messages deterministically', () => {
    const prompt = renderChatPrompt([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
    expect(prompt).toBe('<|system|>\ns</|system|>\n<|user|>\nu</|user|>\n<|assistant|>\n');
  });
});
