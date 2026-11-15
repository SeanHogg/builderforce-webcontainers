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
} from './protocol.js';
import { createModelCache, type ModelCache } from './modelCache.js';
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
  /** Spawn the inference worker. Default: `new Worker(new URL('./inference/worker.js', import.meta.url), { type: 'module' })`. */
  createWorker?: () => InferenceWorkerLike;
  /** Model cache; default IndexedDB via `createModelCache()`. */
  cache?: ModelCache;
  /** Fetch a model's bytes from its source URL (only called on a cache miss). */
  fetchModel?: (ref: ModelRef) => Promise<ArrayBuffer>;
  logger?: (message: string) => void;
}

interface Pending {
  resolve: (reply: never) => void;
  reject: (error: Error) => void;
}

interface StreamState {
  done(stats: GenerationStats): void;
  fail(error: Error): void;
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

export function createInferenceClient(options: InferenceClientOptions = {}): InferenceClient {
  const cache = options.cache ?? createModelCache();
  const fetchModel =
    options.fetchModel ??
    (async (ref) => {
      if (!ref.source || ref.source.kind !== 'url') throw new Error(`model ${ref.id} has no url source`);
      const res = await fetch(ref.source.url);
      if (!res.ok) throw new Error(`failed to fetch ${ref.source.url}: ${res.status}`);
      return res.arrayBuffer();
    });
  const worker =
    options.createWorker ??
    (() =>
      new Worker(new URL('./inference/worker.js', import.meta.url), {
        type: 'module',
      }) as unknown as InferenceWorkerLike);

  let activeWorker: InferenceWorkerLike | undefined;
  const getWorker = () => (activeWorker ??= worker());
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const streams = new Map<number, StreamState>();
  const queue = new Map<number, InferenceToken[]>();
  const waiters = new Map<number, () => void>();
  let workerFailed: Error | undefined;

  const handleReply = (reply: InferenceReply) => {
    if (reply.type === INFERENCE_LOG) {
      options.logger?.((reply as LogReply).message);
      return;
    }
    if (reply.type === INFERENCE_TOKEN) {
      const token = reply as TokenReply;
      const q = queue.get(token.requestId);
      if (q) q.push({ token: token.token, index: token.index });
      waiters.get(token.requestId)?.();
      return;
    }
    if (reply.type === INFERENCE_DONE) {
      const done = reply as DoneReply;
      streams.get(done.requestId)?.done({
        promptTokens: done.promptTokens,
        generatedTokens: done.generatedTokens,
        ttftMs: done.ttftMs,
        decodeMs: done.decodeMs,
        tokensPerSecond: done.tokensPerSecond,
      });
      waiters.get(done.requestId)?.();
      return;
    }
    if (reply.type === INFERENCE_ERROR) {
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
    const waiting = pending.get((reply as { id: number }).id);
    if (waiting) {
      pending.delete((reply as { id: number }).id);
      (waiting.resolve as (value: never) => void)(reply as never);
    }
  };

  const wire = (w: InferenceWorkerLike) => {
    w.onmessage = (event) => handleReply(event.data as InferenceReply);
    w.onerror = (event) => {
      workerFailed = new Error(event.message ?? 'inference worker failed');
      for (const [, p] of pending) p.reject(workerFailed);
      for (const [, s] of streams) s.fail(workerFailed);
      pending.clear();
      streams.clear();
    };
  };

  const request = <T>(message: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (workerFailed) return reject(workerFailed);
      const id = nextId++;
      const w = getWorker();
      wire(w);
      pending.set(id, { resolve: resolve as (reply: never) => void, reject });
      const transfer = message.type === INFERENCE_LOAD ? [(message.weights as ArrayBuffer).slice(0) as Transferable] : undefined;
      w.postMessage({ ...message, id }, transfer);
    });

  const client: InferenceClient = {
    cache,

    async probe() {
      const reply = await request<ReadyReply>({ type: INFERENCE_PROBE });
      return reply.capabilities;
    },

    async load(ref) {
      const cached = await cache.get(ref.id);
      let weights: ArrayBuffer;
      if (cached) {
        weights = cached.bytes;
      } else {
        weights = await fetchModel(ref);
        await cache.put(ref.id, {
          quantization: ref.quantization,
          paramsB: ref.paramsB,
          bytes: weights.slice(0),
          size: weights.byteLength,
        });
      }
      await request({ type: INFERENCE_LOAD, ref, weights });
    },

    generate(messages, genOptions) {
      const id = nextId++;
      const w = getWorker();
      wire(w);
      const q: InferenceToken[] = [];
      let notify: (() => void) | undefined;
      let streamError: Error | undefined;
      let resolveStats!: (stats: GenerationStats) => void;
      let rejectStats!: (error: Error) => void;
      const stats = new Promise<GenerationStats>((resolve, reject) => {
        resolveStats = resolve;
        rejectStats = reject;
      });
      stats.catch(() => {}); // The consumer may only observe the iterator; never leave this hanging.
      queue.set(id, q);
      waiters.set(id, () => notify?.());
      streams.set(id, {
        done: (s) => {
          streams.delete(id);
          waiters.delete(id);
          queue.delete(id);
          resolveStats(s);
          notify?.();
        },
        fail: (error) => {
          streams.delete(id);
          waiters.delete(id);
          queue.delete(id);
          streamError = error;
          rejectStats(error);
          notify?.();
        },
      });
      w.postMessage({ type: INFERENCE_GENERATE, id, messages, options: genOptions });

      const iterable = (async function* (): AsyncIterable<InferenceToken> {
        try {
          for (;;) {
            while (q.length) yield q.shift() as InferenceToken;
            if (streamError) throw streamError;
            if (!streams.has(id)) break;
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        } finally {
          streams.delete(id);
        }
      })();

      return Object.assign(iterable, { stats });
    },

    cancel() {
      activeWorker?.postMessage({ type: INFERENCE_CANCEL, id: nextId++ });
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
