/**
 * Phase 1 — Local CPU Inference Engine: worker protocol.
 *
 * Messages between the host-side `InferenceClient` and the inference worker.
 * Structured so a future Phase 4/5 can add streaming KV-cache and prefill
 * messages without reworking the envelope.
 */

import type { ChatMessage, GenerateOptions, ModelRef, RuntimeCapabilities } from './types.js';

/** Generate options as they cross the wire: an AbortSignal is not structured-cloneable, so it never does. */
export type WireGenerateOptions = Omit<GenerateOptions, 'signal'>;

export const INFERENCE_PROBE = 'inference:probe';
export const INFERENCE_LOAD = 'inference:load';
export const INFERENCE_GENERATE = 'inference:generate';
export const INFERENCE_CANCEL = 'inference:cancel';
export const INFERENCE_DISPOSE_MODEL = 'inference:dispose-model';
export const INFERENCE_CAPABILITIES = 'inference:capabilities';
export const INFERENCE_READY = 'inference:ready';
export const INFERENCE_ERROR = 'inference:error';
export const INFERENCE_LOG = 'inference:log';
export const INFERENCE_TOKEN = 'inference:token';
export const INFERENCE_DONE = 'inference:done';

export interface ProbeRequest {
  type: typeof INFERENCE_PROBE;
  id: number;
}

export interface LoadRequest {
  type: typeof INFERENCE_LOAD;
  id: number;
  ref: ModelRef;
  /** Model bytes, transferred by the host (ArrayBuffer transfer). */
  weights: ArrayBuffer;
}

export interface GenerateRequest {
  type: typeof INFERENCE_GENERATE;
  id: number;
  messages: ChatMessage[];
  options?: WireGenerateOptions;
}

export interface CancelRequest {
  type: typeof INFERENCE_CANCEL;
  id: number;
  /** The generate request to cancel; absent = whatever generation is running. */
  requestId?: number;
}

export interface DisposeModelRequest {
  type: typeof INFERENCE_DISPOSE_MODEL;
  id: number;
}

export type InferenceRequest =
  | ProbeRequest
  | LoadRequest
  | GenerateRequest
  | CancelRequest
  | DisposeModelRequest;

export interface ReadyReply {
  type: typeof INFERENCE_READY;
  id: number;
  capabilities: RuntimeCapabilities;
}

export interface ErrorReply {
  type: typeof INFERENCE_ERROR;
  id: number;
  message: string;
}

export interface LogReply {
  type: typeof INFERENCE_LOG;
  id: number;
  message: string;
}

export interface TokenReply {
  type: typeof INFERENCE_TOKEN;
  id: number;
  requestId: number;
  token: string;
  index: number;
}

export interface DoneReply {
  type: typeof INFERENCE_DONE;
  id: number;
  requestId: number;
  promptTokens: number;
  /** True when `promptTokens` is the ~4 chars/token heuristic, not the backend's tokenizer count. */
  promptTokensEstimated: boolean;
  generatedTokens: number;
  ttftMs: number;
  decodeMs: number;
  tokensPerSecond: number;
}

export type InferenceReply =
  | ReadyReply
  | ErrorReply
  | LogReply
  | TokenReply
  | DoneReply;

/** Stats part of a DoneReply, shared with the public API. */
export interface GenerationStatsPayload {
  promptTokens: number;
  promptTokensEstimated: boolean;
  generatedTokens: number;
  ttftMs: number;
  decodeMs: number;
  tokensPerSecond: number;
}
