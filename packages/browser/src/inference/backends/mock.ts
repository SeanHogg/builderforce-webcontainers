/**
 * Phase 1 — Local CPU Inference Engine: deterministic mock backend.
 *
 * Fixture-backed stand-in for a real 1B Q4 model. It generates a fixed token
 * stream from a small embedded "vocabulary", sleeps `msPerToken` between
 * tokens to simulate decode, and is used to validate the worker comms,
 * caching, and offline paths without downloading a real model — this
 * environment has no headless browser and no model host. The mock is a
 * first-class backend in the abstraction so the runtime is testable end to
 * end; real backends plug into the same interface.
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

/** Tiny deterministic vocabulary the mock decodes from. */
export const MOCK_VOCAB = [
  'the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'and', 'runs',
  'through', 'forest', 'while', 'birds', 'sing', 'softly', 'in', 'morning', 'light', '.',
];

export interface MockBackendOptions {
  /** Simulated decode latency per token (ms). Default 50 → 20 tok/s. */
  msPerToken?: number;
  /** Deterministic seed offset so repeated runs give the same stream. */
  seed?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createMockBackend(options: MockBackendOptions = {}): InferenceBackend {
  const msPerToken = options.msPerToken ?? 50;
  const seed = options.seed ?? 0;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let loaded: ModelRef | undefined;

  return {
    kind: 'mock',

    async probe(): Promise<BackendInfo> {
      return { kind: 'mock', available: true, wasmSimd: false, webgpu: false };
    },

    async load(model, _weights, context: BackendContext): Promise<void> {
      loaded = model;
      context.log(`mock: loaded ${model.id}`);
    },

    async *generate(messages: ChatMessage[], genOptions?: GenerateOptions): AsyncIterable<InferenceToken> {
      if (!loaded) throw new Error('mock: generate called before load');
      const maxTokens = genOptions?.maxTokens ?? 32;
      const prompt = renderChatPrompt(messages);
      // Deterministic token stream: hash the prompt so different prompts
      // give different (but stable) output.
      let hash = seed;
      for (let i = 0; i < prompt.length; i++) hash = (hash * 31 + prompt.charCodeAt(i)) | 0;
      for (let index = 0; index < maxTokens; index++) {
        if (genOptions?.signal?.aborted) return;
        await sleep(msPerToken);
        hash = (hash * 1103515245 + 12345) | 0;
        yield { token: MOCK_VOCAB[Math.abs(hash) % MOCK_VOCAB.length] ?? 'the', index };
      }
    },

    async dispose(): Promise<void> {
      loaded = undefined;
    },
  };
}
