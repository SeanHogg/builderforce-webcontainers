/**
 * Phase 1 — Local CPU Inference Engine: Wllama (llama.cpp WASM) backend.
 *
 * Registered as an alternative CPU backend. Like the ONNX adapter, it wraps
 * an injected `WllamaModule` so this package carries no llama.cpp/wllama
 * dependency; a host that prefers GGUF models provides the module. Kept as
 * the secondary path pending the Phase 1 decision recorded in
 * `docs/phase-1/report.md`.
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
import { renderChatPrompt } from './onnx.js';

export interface WllamaModule {
  init(config: { simd: boolean }): Promise<void>;
  loadModel(weights: ArrayBuffer, modelId: string): Promise<WllamaModel>;
}

export interface WllamaModel {
  generate(prompt: string, options: { maxTokens: number; temperature: number }): AsyncIterable<string>;
  release(): Promise<void>;
}

export interface WllamaBackendOptions {
  loadModule(): Promise<WllamaModule>;
}

export function createWllamaBackend(options: WllamaBackendOptions): InferenceBackend {
  let module: WllamaModule | undefined;
  let model: WllamaModel | undefined;

  return {
    kind: 'wllama',

    async probe(): Promise<BackendInfo> {
      const wasm = typeof WebAssembly !== 'undefined';
      const wasmSimd = wasm && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11]));
      return {
        kind: 'wllama',
        available: wasm,
        reason: wasm ? undefined : 'WebAssembly not available',
        wasmSimd,
        webgpu: false,
      };
    },

    async load(modelRef: ModelRef, weights: ArrayBuffer, context: BackendContext): Promise<void> {
      module ??= await options.loadModule();
      await module.init({ simd: context.wasmSimd });
      model = await module.loadModel(weights, modelRef.id);
      context.log(`wllama: loaded ${modelRef.id}`);
    },

    async *generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken> {
      if (!model) throw new Error('wllama: generate called before load');
      let index = 0;
      for await (const token of model.generate(renderChatPrompt(messages), {
        maxTokens: options?.maxTokens ?? 256,
        temperature: options?.temperature ?? 0.7,
      })) {
        yield { token, index: index++ };
      }
    },

    async dispose(): Promise<void> {
      await model?.release();
      model = undefined;
    },
  };
}
