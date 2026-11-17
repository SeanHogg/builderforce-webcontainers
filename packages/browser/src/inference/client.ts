import {
  INFERENCE_CANCEL,
  INFERENCE_DISPOSE_MODEL,
  INFERENCE_DONE,
  INFERENCE_ERROR,
  INFERENCE_GENERATE,
  INFERENCE_LOAD,
  INFERENCE_LOG,
  INFERENCE_PROBE,
  INFERENCE_TOKEN,
  type DoneReply,
  type ErrorReply,
  type InferenceReply,
  type LogReply,
  type ReadyReply,
  type TokenReply,
  type WireGenerateOptions,
} from './protocol.js';
import { createModelCache, type ModelCache } from './modelCache.js';
import { createTokenStream, type TokenStream } from './tokenStream.js';
import type {
  ChatMessage,
  GenerateOptions,
  GenerationStats,
  InferenceToken,
  ModelRef,
  RuntimeCapabilities,
} from './types.js';

/** Minimal Worker surface the client needs (real Worker, tests, or a port). */
export interface InferenceWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface InferenceClientOptions {
  /**
   * Spawn the inference worker. Default: a classic Worker on the bundled
   * `worker.bundle.js` that sits beside this module in `dist/inference/`
   * (also exported as `@seanhogg/builderforce-webcontainers/ml/worker.js`).
   */
  createWorker?: () => InferenceWorkerLike;
  /** Model cache; default IndexedDB via `createModelCache()`. */
  cache?: ModelCache;
  /**
   * Fetch a model's bytes from its source URL (only called on a cache miss).
   * The returned buffer is TRANSFERRED to the worker, so do not keep using it.
   */
  fetchModel?: (ref: ModelRef) => Promise<ArrayBuffer>;
  logger?: (message: string) => void;
}

interface Pending {
  resolve: (reply: never) => void;
  reject: (error: Error) => void;
}

export interface InferenceClient {
  probe(): Promise<RuntimeCapabilities>;
  /**
   * Ensure the model is cached and loaded in the worker. After this resolves,
   * `generate()` makes no network access — the bytes came from the cache.
   */
  load(ref: ModelRef): Promise<void>;
  generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<InferenceToken> & {
    stats: Promise<GenerationStats>;
  };
  cancel(): void;
  dispose(): Promise<void>;
  readonly cache: ModelCache;
}

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

function defaultFetchModel(ref: ModelRef): Promise<ArrayBuffer> {
  if (!ref.source || ref.source.kind !== 'url') return Promise.reject(new Error(`model ${ref.id} has no url source`));
  const url = ref.source.url;
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
    return res.arrayBuffer();
  });
}

function defaultCreateWorker(): InferenceWorkerLike {
  // The IIFE bundle emitted by scripts/build-sw.mjs beside dist/inference/client.js.
  // ESM only (import.meta.url): a CommonJS consumer of ./ml must pass `createWorker`.
  return new Worker(new URL('./worker.bundle.js', import.meta.url)) as unknown as InferenceWorkerLike;
}

export function createInferenceClient(options: InferenceClientOptions = {}): InferenceClient {
  const cache = options.cache ?? createModelCache();
  const fetchModel = options.fetchModel ?? defaultFetchModel;
  const spawn = options.createWorker ?? defaultCreateWorker;

  let activeWorker: InferenceWorkerLike | undefined;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const streams = new Map<number, TokenStream>();
  let workerFailed: Error | undefined;

  const handleReply = (reply: InferenceReply) => {
    switch (reply.type) {
      case INFERENCE_LOG:
        options.logger?.((reply as LogReply).message);
        return;
      case INFERENCE_TOKEN: {
        const token = reply as TokenReply;
        streams.get(token.requestId)?.push({ token: token.token, index: token.index });
        return;
      }
      case INFERENCE_DONE: {
        const done = reply as DoneReply;
        streams.get(done.requestId)?.done({
          promptTokens: done.promptTokens,
          promptTokensEstimated: done.promptTokensEstimated,
          generatedTokens: done.generatedTokens,
          ttftMs: done.ttftMs,
          decodeMs: done.decodeMs,
          tokensPerSecond: done.tokensPerSecond,
        });
        return;
      }
      case INFERENCE_ERROR: {
        const error = reply as ErrorReply;
        const waiting = pending.get(error.id);
        if (waiting) {
          pending.delete(error.id);
          waiting.reject(new Error(error.message));
        } else {
          streams.get(error.id)?.fail(new Error(error.message));
        }
        return;
      }
    }
    const id = (reply as { id: number }).id;
    const waiting = pending.get(id);
    if (waiting) {
      pending.delete(id);
      (waiting.resolve as (value: never) => void)(reply as never);
    }
  };

  /** Reject every in-flight request and stream; later calls reject immediately. */
  const failAll = (error: Error) => {
    workerFailed = error;
    const waiting = [...pending.values()];
    const open = [...streams.values()];
    pending.clear();
    streams.clear();
    for (const p of waiting) p.reject(error);
    for (const s of open) s.fail(error);
  };

  const getWorker = (): InferenceWorkerLike => {
    if (activeWorker) return activeWorker;
    const w = spawn();
    w.onmessage = (event) => handleReply(event.data as InferenceReply);
    w.onerror = (event) => failAll(new Error(event.message ?? 'inference worker failed'));
    activeWorker = w;
    return w;
  };

  const request = <T>(message: Record<string, unknown>, transfer?: Transferable[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (workerFailed) return reject(workerFailed);
      const id = nextId++;
      pending.set(id, { resolve: resolve as (reply: never) => void, reject });
      try {
        getWorker().postMessage({ ...message, id }, transfer);
      } catch (error) {
        pending.delete(id);
        reject(toError(error));
      }
    });

  /** Ask the worker to stop one generate request (fire-and-forget). */
  const sendCancel = (requestId: number) => {
    try {
      activeWorker?.postMessage({ type: INFERENCE_CANCEL, id: nextId++, requestId });
    } catch {
      /* worker gone: nothing to cancel */
    }
  };

  const client: InferenceClient = {
    cache,

    async probe() {
      const reply = await request<ReadyReply>({ type: INFERENCE_PROBE });
      return reply.capabilities;
    },

    async load(ref) {
      // Per the ModelCache ownership contract, `get` hands back a buffer we own
      // and `put` never retains ours — so the bytes are transferred to the
      // worker with no copy made here (IndexedDB's own clone is the only one).
      const cached = await cache.get(ref.id);
      let weights: ArrayBuffer;
      if (cached) {
        weights = cached.bytes;
      } else {
        weights = await fetchModel(ref);
        // Awaited BEFORE the transfer below: `put` clones the bytes (IndexedDB's
        // structured clone runs once its store has opened), and a transfer first
        // would hand it a detached buffer. The write is best-effort — a quota abort
        // (or any cache failure) must not stop the model loading; it just isn't cached.
        try {
          await cache.put(ref.id, {
            quantization: ref.quantization,
            paramsB: ref.paramsB,
            bytes: weights,
            size: weights.byteLength,
          });
        } catch (error) {
          options.logger?.(`model cache write failed for ${ref.id}: ${toError(error).message}`);
        }
      }
      await request({ type: INFERENCE_LOAD, ref, weights }, [weights]);
    },

    generate(messages, genOptions = {}) {
      const id = nextId++;
      // An AbortSignal is not structured-cloneable: it stays host-side and is
      // translated into an INFERENCE_CANCEL for this request.
      const { signal, ...wireOptions } = genOptions;
      const onAbort = () => sendCancel(id);
      const stream = createTokenStream(() => {
        streams.delete(id);
        signal?.removeEventListener('abort', onAbort);
      });
      const result = (s: TokenStream) =>
        Object.assign(
          s.iterate(() => sendCancel(id)),
          { stats: s.stats },
        );

      if (workerFailed) {
        stream.fail(workerFailed);
        return result(stream);
      }
      try {
        const w = getWorker();
        streams.set(id, stream);
        w.postMessage({ type: INFERENCE_GENERATE, id, messages, options: wireOptions satisfies WireGenerateOptions });
      } catch (error) {
        stream.fail(toError(error)); // also removes the map entry
        return result(stream);
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      return result(stream);
    },

    cancel() {
      try {
        activeWorker?.postMessage({ type: INFERENCE_CANCEL, id: nextId++ });
      } catch {
        /* worker gone */
      }
    },

    async dispose() {
      try {
        await request({ type: INFERENCE_DISPOSE_MODEL });
      } finally {
        activeWorker?.terminate();
        activeWorker = undefined;
      }
    },
  };
  return client;
}
