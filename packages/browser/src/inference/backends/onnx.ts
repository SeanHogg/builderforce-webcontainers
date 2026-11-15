/**
 * Phase 1 — Local CPU Inference Engine: ONNX Runtime Web backend.
 *
 * Chosen as the primary CPU-first backend (see `docs/phase-1/report.md` for
 * the tradeoff analysis against Wllama/llama.cpp WASM and WebLLM). The
 * backend is an adapter over a `ort-wasm` module object — tests inject a
 * mock module; the browser loads the real `onnxruntime-web` package (an
 * optional dependency the host app provides). Nothing here imports the
 * package directly, keeping the core package dependency-free and the
 * backend swappable.
 */

import type {
  BackendContext,
  BackendInfo,
  ChatMessage,
  GenerateOptions,
  InferenceBackend,
  InferenceToken,
  ModelRef,
} from '../types.js';
import { detectBackendEnv } from '../capabilities.js';

/** Minimal shape of the onnxruntime-web wasm inference session we use. */
export interface OrtWasmModule {
  initRuntime(wasmSimd: boolean): Promise<void>;
  createSession(weights: ArrayBuffer, modelId: string): Promise<OrtSession>;
}

export interface OrtSession {
  run(prompt: string, options: { maxTokens: number; temperature: number; signal?: AbortSignal }): AsyncIterable<string>;
  release(): Promise<void>;
}

export interface OnnxBackendOptions {
  /** Load/inject the wasm module. Only called when the backend is used. */
  loadModule(): Promise<OrtWasmModule>;
}

export function createOnnxBackend(options: OnnxBackendOptions): InferenceBackend {
  let module: OrtWasmModule | undefined;
  let session: OrtSession | undefined;
  let loadedRef: ModelRef | undefined;

  return {
    kind: 'onnx',

    async probe(): Promise<BackendInfo> {
      const env = detectBackendEnv();
      return {
        kind: 'onnx',
        available: env.wasm,
        reason: env.wasm ? undefined : 'WebAssembly not available',
        wasmSimd: env.wasmSimd,
        webgpu: false,
      };
    },

    async load(model, weights, context: BackendContext): Promise<void> {
      module ??= await options.loadModule();
      await module.initRuntime(context.wasmSimd);
      session = await module.createSession(weights, model.id);
      loadedRef = model;
      context.log(`onnx: loaded ${model.id} (${model.quantization}, ${model.paramsB}B)`);
    },

    async *generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken> {
      if (!session) throw new Error('onnx: generate called before load');
      const prompt = renderChatPrompt(messages);
      const maxTokens = options?.maxTokens ?? 256;
      const temperature = options?.temperature ?? 0.7;
      let index = 0;
      for await (const token of session.run(prompt, { maxTokens, temperature, signal: options?.signal })) {
        yield { token, index: index++ };
      }
    },

    async dispose(): Promise<void> {
      await session?.release();
      session = undefined;
      loadedRef = undefined;
    },
  };
}

/** Shared chat-prompt renderer — deterministic, used by all backends. */
export function renderChatPrompt(messages: ChatMessage[]): string {
  return messages
    .map((m) => `<|${m.role}|>\n${m.content}</|${m.role}|>`)
    .join('\n') + '\n<|assistant|>\n';
}
