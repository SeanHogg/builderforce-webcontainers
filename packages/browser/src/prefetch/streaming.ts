/**
 * Phase 4 — Predictive Prefetching: streaming primitives.
 *
 * Two independent concerns live here:
 *
 *   1. `createDoubleBuffer` — a two-slot buffer. The slot being consumed is
 *      never the slot being filled: a producer writes into the *staged* slot
 *      while the consumer drains the *current* slot, and the swap is atomic.
 *      This is what keeps a prefetch (or a streamed chunk) from corrupting
 *      the data the consumer is actively reading.
 *
 *   2. `createPrefillStream` — an adapter that streams PREFILL tokens when the
 *      backend supports it, and degrades gracefully (silently skipping the
 *      prefill phase) when it does not. Support is a probed FACT, never a
 *      gate: an unsupported backend still produces the same decode tokens.
 *
 * Both are pure TypeScript with no dependencies and no browser-only globals
 * beyond `AbortSignal`, which is used opaquely.
 */

/** A two-slot buffer: the consumed slot and the staging slot. */
export interface DoubleBuffer<T> {
  /** The value currently being consumed (undefined when empty). */
  current(): T | undefined;
  /** The value staged for the next swap (undefined when nothing is staged). */
  staged(): T | undefined;
  /** True when a value is staged and ready to be swapped in. */
  hasStaged(): boolean;
  /** Stage the next value. Replaces any previously staged value. */
  stage(next: T): void;
  /**
   * Swap the staged value into the consumed slot. Returns the value that was
   * previously current (so the caller can release it), or undefined when
   * nothing was staged.
   */
  swap(): T | undefined;
  /** Set the consumed slot directly (used for the very first value). */
  setCurrent(value: T): void;
  /** Drop the staged value without swapping (e.g. it was invalidated). */
  discardStaged(): void;
  /** True when nothing is staged and nothing is current. */
  isEmpty(): boolean;
}

export function createDoubleBuffer<T>(initial?: T): DoubleBuffer<T> {
  let currentValue: T | undefined = initial;
  let stagedValue: T | undefined;
  return {
    current: () => currentValue,
    staged: () => stagedValue,
    hasStaged: () => stagedValue !== undefined,
    stage(next: T) {
      stagedValue = next;
    },
    swap() {
      if (stagedValue === undefined) return undefined;
      const previous = currentValue;
      currentValue = stagedValue;
      stagedValue = undefined;
      return previous;
    },
    setCurrent(value: T) {
      currentValue = value;
    },
    discardStaged() {
      stagedValue = undefined;
    },
    isEmpty: () => currentValue === undefined && stagedValue === undefined,
  };
}

/** A chunk produced by a streaming producer. */
export interface StreamChunk<T> {
  /** The payload. */
  value: T;
  /** Sequence number, used to detect gaps. */
  index: number;
}

/**
 * Drive a producer through a double buffer so the consumer always reads a
 * stable chunk while the next one is being produced.
 *
 * The producer is called with an `AbortSignal`; aborting it stops the pipeline
 * and the consumer's iterator ends.
 */
export async function* pumpDoubleBuffer<T>(
  produce: (signal: AbortSignal) => AsyncIterable<T>,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<StreamChunk<T>> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const buffer = createDoubleBuffer<T>();
  let index = 0;
  try {
    for await (const value of produce(controller.signal)) {
      if (controller.signal.aborted) break;
      // Stage the freshly produced value while the consumer holds the
      // previous one; the swap happens on the next iteration.
      buffer.stage(value);
      const previous = buffer.swap();
      void previous;
      yield { value: buffer.current() as T, index: index++ };
    }
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** One token emitted by a prefill-capable backend. */
export interface PrefillToken {
  /** The token text (may be empty for a pure progress marker). */
  token: string;
  /** Index within the prefill stream. */
  index: number;
  /** True when this is the final prefill token. */
  done?: boolean;
}

/** Options accepted by the prefill stream adapter. */
export interface PrefillStreamOptions {
  /** The prompt messages being prefilled. */
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** Maximum tokens to prefill. */
  maxPrefillTokens?: number;
  /** Abort the stream. */
  signal?: AbortSignal;
}

/**
 * The backend contract the prefill adapter probes for.
 *
 * `supportsPrefillStreaming` is optional: when it is absent the adapter
 * assumes prefill streaming is NOT supported and degrades gracefully.
 */
export interface PrefillStreamBackend {
  /** Probe (or state) whether prefill tokens can be streamed. */
  supportsPrefillStreaming?(): boolean | Promise<boolean>;
  /** Stream prefill tokens. Only called when support was reported. */
  streamPrefill?(options: PrefillStreamOptions): AsyncIterable<PrefillToken> | Promise<AsyncIterable<PrefillToken>>;
  /** Stream the decode phase. Always required. */
  streamDecode?(options: PrefillStreamOptions): AsyncIterable<{ token: string }> | AsyncIterable<string>;
}

/** What the adapter produced, for accounting. */
export interface PrefillStreamResult {
  /** Prefill tokens yielded (0 when the backend cannot stream prefill). */
  prefillTokens: number;
  /** True when the backend streamed prefill tokens. */
  streamedPrefill: boolean;
  /** Decode tokens yielded. */
  decodeTokens: number;
}

/**
 * A prefill/decode stream that degrades gracefully.
 *
 * When the backend supports prefill streaming, prefill tokens are yielded
 * first (they are the "warm-up" of the request and let the caller render
 * progress before the first decode token). When it does not, the adapter
 * yields no prefill tokens and streams decode only — the caller sees the same
 * decode tokens either way, so nothing downstream has to special-case it.
 */
export interface PrefillStream {
  /** Iterate the combined prefill + decode stream. */
  stream(options: PrefillStreamOptions): AsyncGenerator<PrefillToken>;
  /** Iterate and collect the accounting. */
  run(options: PrefillStreamOptions): Promise<PrefillStreamResult>;
}

/**
 * Create the prefill stream adapter.
 *
 * The backend's support probe is consulted once per `stream()` call, so a
 * backend that gains support at runtime is picked up without recreating the
 * adapter.
 */
export function createPrefillStream(backend: PrefillStreamBackend): PrefillStream {
  async function* generate(options: PrefillStreamOptions): AsyncGenerator<PrefillToken> {
    let streamedPrefill = false;
    const supported = await probeSupport(backend);
    if (supported && backend.streamPrefill) {
      const prefill = await backend.streamPrefill(options);
      let index = 0;
      for await (const token of prefill) {
        if (options.signal?.aborted) return;
        streamedPrefill = true;
        yield { token: token.token, index: index++, done: token.done };
      }
    }
    if (!backend.streamDecode) return;
    const decode = backend.streamDecode(options);
    for await (const event of decode) {
      if (options.signal?.aborted) return;
      const token = typeof event === 'string' ? event : event.token;
      yield { token, index: -1 };
    }
    void streamedPrefill;
  }

  return {
    stream: generate,
    async run(options) {
      let prefillTokens = 0;
      let decodeTokens = 0;
      let streamedPrefill = false;
      for await (const token of generate(options)) {
        if (token.index >= 0) {
          prefillTokens += 1;
          streamedPrefill = true;
        } else {
          decodeTokens += 1;
        }
      }
      return { prefillTokens, decodeTokens, streamedPrefill };
    },
  };
}

/** Probe prefill-streaming support without ever throwing. */
export async function probeSupport(backend: PrefillStreamBackend): Promise<boolean> {
  if (!backend.supportsPrefillStreaming) return false;
  if (!backend.streamPrefill) return false;
  try {
    const supported = await backend.supportsPrefillStreaming();
    return supported === true;
  } catch {
    return false;
  }
}
