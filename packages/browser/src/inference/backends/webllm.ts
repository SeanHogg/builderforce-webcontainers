/**
 * Phase 1 — Local CPU Inference Engine: WebLLM backend (optional).
 *
 * WebLLM is WebGPU-only, so it is OPTIONAL and never required for core
 * functionality — CPU-only operation must remain fully supported. This
 * adapter reports unavailable when WebGPU is absent and the runtime's
 * backend selection never depends on it. It exists so the abstraction is
 * proven to host a WebGPU backend ahead of Phase 5.
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

export interface WebLlmModule {
  init(): Promise<void>;
  loadModel(modelId: string): Promise<WebLlmModel>;
}

export interface WebLlmModel {
  generate(prompt: string, options: { maxTokens: number; temperature: number }): AsyncIterable<string>;
  release(): Promise<void>;
}

export interface WebLlmBackendOptions {
  loadModule(): Promise<WebLlmModule>;
}

export function createWebLlmBackend(options: WebLlmBackendOptions): InferenceBackend {
  let module: WebLlmModule | undefined;
  let model: WebLlmModel | undefined;

  return {
    kind: 'webllm',

    async probe(): Promise<BackendInfo> {
      const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
      return {
        kind: 'webllm',
        available: webgpu,
        reason: webgpu ? undefined : 'WebGPU not available (WebLLM requires WebGPU)',
        wasmSimd: false,
        webgpu,
      };
    },

    async load(modelRef: ModelRef, _weights: ArrayBuffer, context: BackendContext): Promise<void> {
      if (!context.webgpu) throw new Error('webllm: WebGPU not available');
      module ??= await options.loadModule();
      await module.init();
      model = await module.loadModel(modelRef.id);
      context.log(`webllm: loaded ${modelRef.id}`);
    },

    async *generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken> {
      if (!model) throw new Error('webllm: generate called before load');
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
