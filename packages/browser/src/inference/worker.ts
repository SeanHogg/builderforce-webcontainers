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
  type InferenceReply,
  type InferenceRequest,
} from './protocol.js';
import { probeRuntimeCapabilities } from './capabilities.js';
import type { BackendContext, InferenceBackend } from './types.js';

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
      return typeof SharedArrayBuffer !== 'undefined';
    },
    get wasmSimd() {
      return probeRuntimeCapabilities().wasmSimd;
    },
    get webgpu() {
      return typeof navigator !== 'undefined' && 'gpu' in navigator;
    },
  };

  let active: InferenceBackend | undefined;
  let activeAbort: AbortController | undefined;

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

  async function handleGenerate(id: number, request: Extract<InferenceRequest, { type: typeof INFERENCE_GENERATE }>) {
    if (!active) throw new Error('no model loaded');
    activeAbort?.abort();
    const abort = new AbortController();
    activeAbort = abort;
    // A caller-supplied signal wins; otherwise the worker-side controller
    // (cancel request / next generate) drives cancellation. When the caller's
    // signal fires we also fire ours so the backend sees a single signal.
    const callerSignal = request.options?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) abort.abort();
      else callerSignal.addEventListener('abort', () => abort.abort(), { once: true });
    }
    const signal = abort.signal;
    const started = now();
    let firstTokenAt = -1;
    let generated = 0;
    try {
      for await (const { token, index } of active.generate(request.messages, {
        ...request.options,
        signal,
      })) {
        if (firstTokenAt < 0) firstTokenAt = now();
        generated++;
        worker.postMessage({ type: INFERENCE_TOKEN, id, requestId: id, token, index });
      }
      const finished = now();
      const ttftMs = firstTokenAt >= 0 ? firstTokenAt - started : finished - started;
      const decodeMs = firstTokenAt >= 0 ? finished - firstTokenAt : 0;
      const done: DoneReply = {
        type: INFERENCE_DONE,
        id,
        requestId: id,
        promptTokens: request.messages.reduce((n, m) => n + m.content.length, 0),
        generatedTokens: generated,
        ttftMs,
        decodeMs,
        tokensPerSecond: decodeMs > 0 ? (generated / decodeMs) * 1000 : 0,
      };
      reply(done);
    } finally {
      if (activeAbort === abort) activeAbort = undefined;
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
            active = await selectBackend();
            await active.load(request.ref, request.weights, context);
            reply({ type: INFERENCE_READY, id, capabilities: probeRuntimeCapabilities(backends) });
            break;
          }
          case INFERENCE_GENERATE:
            await handleGenerate(id, request);
            break;
          case INFERENCE_CANCEL:
            activeAbort?.abort();
            break;
          case INFERENCE_DISPOSE_MODEL: {
            activeAbort?.abort();
            await active?.dispose();
            active = undefined;
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
