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

  it('forwards the abort signal to the engine call (cancel actually stops it)', async () => {
    // Regression: backends used to accept options.signal but never pass it to
    // session.run / model.generate, so cancel() and a caller's AbortSignal
    // could not stop a real backend mid-run. Each engine below blocks until
    // its signal fires, then throws — a generation that ignores the signal
    // would hang forever and trip the test timeout.
    const makeEngine = () => {
      let seen: AbortSignal | undefined;
      const stream = async function* (_prompt: string, opts: { signal?: AbortSignal }) {
        seen = opts.signal;
        for (let i = 0; i < 500; i++) {
          if (opts.signal?.aborted) throw new Error('aborted');
          await new Promise((r) => setTimeout(r, 5));
          yield 'x';
        }
      };
      return { seen: () => seen, stream };
    };

    // --- onnx ---
    const onnx = makeEngine();
    const onnxBackend = createOnnxBackend({
      loadModule: async () => ({
        initRuntime: async () => {},
        createSession: async () => ({ run: onnx.stream, release: async () => {} }),
      }),
    });
    await onnxBackend.load(ref, new ArrayBuffer(8), noopContext);
    const c1 = new AbortController();
    const onnxGen = onnxBackend.generate(messages, { maxTokens: 500, signal: c1.signal });
    setTimeout(() => c1.abort(), 20);
    const onnxOut: string[] = [];
    await expect(
      (async () => {
        for await (const { token } of onnxGen) onnxOut.push(token);
      })(),
    ).rejects.toThrow('aborted');
    expect(onnxOut.length).toBeLessThan(500);
    expect(onnx.seen()).toBe(c1.signal); // signal reached the engine call

    // --- wllama ---
    const wl = makeEngine();
    const wlBackend = createWllamaBackend({
      loadModule: async () => ({
        init: async () => {},
        loadModel: async () => ({ generate: wl.stream, release: async () => {} }),
      }),
    });
    await wlBackend.load(ref, new ArrayBuffer(8), noopContext);
    const c2 = new AbortController();
    const wlGen = wlBackend.generate(messages, { maxTokens: 500, signal: c2.signal });
    setTimeout(() => c2.abort(), 20);
    const wlOut: string[] = [];
    await expect(
      (async () => {
        for await (const { token } of wlGen) wlOut.push(token);
      })(),
    ).rejects.toThrow('aborted');
    expect(wlOut.length).toBeLessThan(500);
    expect(wl.seen()).toBe(c2.signal);

    // --- webllm ---
    const llm = makeEngine();
    const llmBackend = createWebLlmBackend({
      loadModule: async () => ({
        init: async () => {},
        loadModel: async () => ({ generate: llm.stream, release: async () => {} }),
      }),
    });
    await llmBackend.load(ref, new ArrayBuffer(8), { ...noopContext, webgpu: true });
    const c3 = new AbortController();
    const llmGen = llmBackend.generate(messages, { maxTokens: 500, signal: c3.signal });
    setTimeout(() => c3.abort(), 20);
    const llmOut: string[] = [];
    await expect(
      (async () => {
        for await (const { token } of llmGen) llmOut.push(token);
      })(),
    ).rejects.toThrow('aborted');
    expect(llmOut.length).toBeLessThan(500);
    expect(llm.seen()).toBe(c3.signal);
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
