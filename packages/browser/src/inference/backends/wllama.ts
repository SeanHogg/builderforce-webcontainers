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
import { detectBackendEnv } from '../capabilities.js';

export interface WllamaModule {
  init(config: { simd: boolean }): Promise<void>;
  loadModel(weights: ArrayBuffer, modelId: string): Promise<WllamaModel>;
}

export interface WllamaModel {
  generate(prompt: string, options: { maxTokens: number; temperature: number; signal?: AbortSignal }): AsyncIterable<string>;
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
      const env = detectBackendEnv();
      return {
        kind: 'wllama',
        available: env.wasm,
        reason: env.wasm ? undefined : 'WebAssembly not available',
        wasmSimd: env.wasmSimd,
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
        signal: options?.signal,
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
