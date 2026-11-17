/**
 * Phase 1 — Local CPU Inference Engine: worker host (runs inside the Worker).
 *
 * Owns the backend registry, drives load/generate/cancel, and streams tokens
 * back to the `InferenceClient` over postMessage. Generation runs here, on
 * the worker thread, so the UI/main thread never blocks on decode. The
 * worker global is typed locally (as in `sw.ts` / `check/worker.ts`) because
 * `lib.webworker` cannot share a compilation with the DOM lib.
 */

import {
  INFERENCE_CANCEL,
  INFERENCE_DISPOSE_MODEL,
  INFERENCE_DONE,
  INFERENCE_ERROR,
  INFERENCE_GENERATE,
  INFERENCE_LOAD,
  INFERENCE_LOG,
  INFERENCE_PROBE,
  INFERENCE_READY,
  INFERENCE_TOKEN,
  type DoneReply,
  type GenerateRequest,
  type InferenceReply,
  type InferenceRequest,
} from './protocol.js';
import { probeRuntimeCapabilities } from './capabilities.js';
import { detectSharedArrayBuffer, detectWasmSimd, detectWebGpu } from '../shared/hardwareProbe.js';
import { estimateTokens } from '../shared/tokens.js';
import type { BackendContext, ChatMessage, InferenceBackend } from './types.js';

interface WorkerGlobalLike {
  postMessage(message: InferenceReply): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: unknown }) => void): void;
}

export interface InferenceWorkerHostOptions {
  /** Backends in preference order; the first available one is used. */
  backends: InferenceBackend[];
  now?: () => number;
}

/** Prompt size: the backend's tokenizer count when it has one, else the shared estimate. */
function countPrompt(backend: InferenceBackend, messages: ChatMessage[]): { tokens: number; estimated: boolean } {
  const exact = backend.countPromptTokens?.(messages);
  if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) return { tokens: exact, estimated: false };
  return { tokens: messages.reduce((n, m) => n + estimateTokens(m.content), 0), estimated: true };
}

/**
 * Wire the host into a worker global. Returns a dispose function that
 * cancels any in-flight generation. Exported for tests, which drive it with
 * a fake worker global.
 */
export function startInferenceWorkerHost(
  worker: WorkerGlobalLike,
  options: InferenceWorkerHostOptions,
): () => void {
  const { backends } = options;
  const now = options.now ?? (() => Date.now());
  const context: BackendContext = {
    log: (message) => worker.postMessage({ type: INFERENCE_LOG, id: -1, message }),
    get sharedArrayBuffer() {
      return detectSharedArrayBuffer();
    },
    get wasmSimd() {
      return detectWasmSimd();
    },
    get webgpu() {
      return detectWebGpu();
    },
  };

  let active: InferenceBackend | undefined;
  let activeAbort: AbortController | undefined;
  let activeRequestId: number | undefined;

  const reply = (message: InferenceReply) => worker.postMessage(message);
  const fail = (id: number, error: unknown) =>
    reply({ type: INFERENCE_ERROR, id, message: error instanceof Error ? error.message : String(error) });

  async function selectBackend(): Promise<InferenceBackend> {
    for (const backend of backends) {
      const info = await backend.probe();
      if (info.available) return backend;
    }
    throw new Error('no inference backend available in this environment');
  }

  /** Abort any running generation and release the loaded model. */
  async function releaseActive(): Promise<void> {
    activeAbort?.abort();
    const previous = active;
    active = undefined;
    await previous?.dispose();
  }

  async function handleGenerate(id: number, request: GenerateRequest) {
    const backend = active;
    if (!backend) throw new Error('no model loaded');
    activeAbort?.abort();
    const abort = new AbortController();
    activeAbort = abort;
    activeRequestId = id;
    const started = now();
    let firstTokenAt = -1;
    let generated = 0;
    try {
      // The wire options never carry a signal (not cloneable); the worker-side
      // controller is the ONE cancellation source (cancel request / next generate).
      for await (const { token, index } of backend.generate(request.messages, {
        ...request.options,
        signal: abort.signal,
      })) {
        if (firstTokenAt < 0) firstTokenAt = now();
        generated++;
        worker.postMessage({ type: INFERENCE_TOKEN, id, requestId: id, token, index });
      }
      const finished = now();
      const ttftMs = firstTokenAt >= 0 ? firstTokenAt - started : finished - started;
      const decodeMs = firstTokenAt >= 0 ? finished - firstTokenAt : 0;
      const prompt = countPrompt(backend, request.messages);
      const done: DoneReply = {
        type: INFERENCE_DONE,
        id,
        requestId: id,
        promptTokens: prompt.tokens,
        promptTokensEstimated: prompt.estimated,
        generatedTokens: generated,
        ttftMs,
        decodeMs,
        tokensPerSecond: decodeMs > 0 ? (generated / decodeMs) * 1000 : 0,
      };
      reply(done);
    } finally {
      if (activeAbort === abort) {
        activeAbort = undefined;
        activeRequestId = undefined;
      }
    }
  }

  const listener = (event: { data: unknown }) => {
    const request = event.data as InferenceRequest | null;
    if (!request || typeof request !== 'object') return;
    const id = request.id;
    void (async () => {
      try {
        switch (request.type) {
          case INFERENCE_PROBE: {
            const capabilities = probeRuntimeCapabilities(backends);
            reply({ type: INFERENCE_READY, id, capabilities });
            break;
          }
          case INFERENCE_LOAD: {
            // Abort + dispose the previous model BEFORE loading the next, so two
            // models are never resident and no stale generation keeps decoding.
            await releaseActive();
            const next = await selectBackend();
            await next.load(request.ref, request.weights, context);
            active = next;
            reply({ type: INFERENCE_READY, id, capabilities: probeRuntimeCapabilities(backends) });
            break;
          }
          case INFERENCE_GENERATE:
            await handleGenerate(id, request);
            break;
          case INFERENCE_CANCEL:
            if (request.requestId === undefined || request.requestId === activeRequestId) activeAbort?.abort();
            break;
          case INFERENCE_DISPOSE_MODEL: {
            await releaseActive();
            reply({ type: INFERENCE_READY, id, capabilities: probeRuntimeCapabilities(backends) });
            break;
          }
        }
      } catch (error) {
        fail(id, error);
      }
    })();
  };

  worker.addEventListener('message', listener);
  return () => worker.removeEventListener?.('message', listener as never);
}

/** Entry point used by the real worker bundle. */
export function runInferenceWorker(backends: InferenceBackend[]): void {
  startInferenceWorkerHost(globalThis as unknown as WorkerGlobalLike, { backends });
}
