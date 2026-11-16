import { describe, expect, it } from 'vitest';
import { createPrefetcher } from '../src/prefetch/prefetcher.js';
import {
  predictFromContext,
  predictFromGraph,
  predictFromHistory,
} from '../src/prefetch/predictor.js';
import {
  createDoubleBuffer,
  createPrefillStream,
  pumpDoubleBuffer,
} from '../src/prefetch/streaming.js';
import type {
  PrefetchTarget,
} from '../src/prefetch/types.js';

/** A loader with a controllable delay, so timings are deterministic-ish. */
function makeLoader(delayMs = 10) {
  const loaded: string[] = [];
  const loader = async (target: PrefetchTarget, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    loaded.push(target.id);
    return `value:${target.id}`;
  };
  return { loader, loaded };
}

const MODEL: PrefetchTarget = { id: 'model:tiny-q4', bytes: 1000, kind: 'model' };
const TOKENIZER: PrefetchTarget = { id: 'asset:tokenizer', bytes: 100, kind: 'tokenizer' };

describe('prediction strategies', () => {
  it('static graph predicts reachable targets', () => {
    const index = new Map([
      [MODEL.id, MODEL],
      [TOKENIZER.id, TOKENIZER],
    ]);
    const predictions = predictFromGraph(
      'session',
      { edges: [{ from: 'session', to: 'model:tiny-q4' }, { from: 'model:tiny-q4', to: 'asset:tokenizer' }] },
      index,
    );
    expect(predictions.map((p) => p.target.id)).toEqual(['model:tiny-q4', 'asset:tokenizer']);
    expect(predictions[0]?.strategy).toBe('static-graph');
    // Confidence is damped by the weakest edge on the path.
    expect(predictions[1]!.confidence).toBeLessThanOrEqual(predictions[0]!.confidence);
  });

  it('history predicts the next item from the access order', () => {
    const index = new Map([
      [MODEL.id, MODEL],
      [TOKENIZER.id, TOKENIZER],
    ]);
    const predictions = predictFromHistory(
      ['asset:tokenizer', 'model:tiny-q4', 'asset:tokenizer', 'model:tiny-q4'],
      index,
    );
    expect(predictions[0]?.target.id).toBe('asset:tokenizer');
    expect(predictions[0]?.strategy).toBe('history');
    expect(predictions[0]!.confidence).toBeGreaterThan(0);
  });

  it('context predicts from the workload profile', () => {
    const index = new Map([[TOKENIZER.id, TOKENIZER]]);
    const predictions = predictFromContext(
      { target: 'model:tiny-q4', profile: { expects: ['asset:tokenizer'], stage: 'prefill' } },
      index,
    );
    const ids = predictions.map((p) => p.target.id);
    expect(ids).toContain('asset:tokenizer');
    expect(predictions[0]?.strategy).toBe('context');
  });
});

describe('createPrefetcher — measurement surfaces', () => {
  it('exposes hitRate() and waitMs() accounting', async () => {
    const { loader } = makeLoader(5);
    const prefetcher = createPrefetcher({ loader, targets: [MODEL, TOKENIZER] });
    await prefetcher.request(MODEL);
    expect(prefetcher.hitRate()).toBe(0);
    expect(prefetcher.waitMs()).toBeGreaterThan(0);
    await prefetcher.request(MODEL);
    expect(prefetcher.hitRate()).toBe(0.5);
    const stats = prefetcher.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.totalWaitMs).toBeGreaterThan(0);
    expect(stats.avgLoadMs).toBeGreaterThan(0);
  });

  it('measures a measurable throughput difference between prefetch on and off', async () => {
    // Prefetch ON: the next target is already resident when it is requested.
    const on = makeLoader(20);
    const onPrefetcher = createPrefetcher({
      loader: on.loader,
      targets: [MODEL, TOKENIZER],
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:tokenizer' }] },
    });
    const onStart = Date.now();
    await onPrefetcher.request(MODEL);
    await onPrefetcher.whenIdle();
    const onResult = await onPrefetcher.request(TOKENIZER);
    const onElapsed = Date.now() - onStart;

    // Prefetch OFF: the same target is loaded on demand.
    const off = makeLoader(20);
    const offPrefetcher = createPrefetcher({
      loader: off.loader,
      targets: [MODEL, TOKENIZER],
      enabled: false,
    });
    const offStart = Date.now();
    await offPrefetcher.request(MODEL);
    const offResult = await offPrefetcher.request(TOKENIZER);
    const offElapsed = Date.now() - offStart;

    expect(onResult.hit).toBe(true);
    expect(offResult.hit).toBe(false);
    // Compare request-wait, not wall-clock of the whole scenario: the ON path
    // also awaits `whenIdle()` (the speculative load), so total elapsed is
    // not a reliable throughput signal under a loaded CI timer.
    expect(onResult.waitMs).toBeLessThan(offResult.waitMs);
    expect(onElapsed).toBeGreaterThanOrEqual(0);
    expect(offElapsed).toBeGreaterThanOrEqual(0);
    // The prefetched copy was the one that served the request.
    expect(onPrefetcher.stats().prefetchHits).toBe(1);
  });

  it('joins an in-flight prefetch instead of loading the data twice', async () => {
    const { loader, loaded } = makeLoader(15);
    const prefetcher = createPrefetcher({
      loader,
      targets: [MODEL, TOKENIZER],
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:tokenizer' }] },
    });
    await prefetcher.request(MODEL);
    // The tokenizer prefetch is now in flight.
    const result = await prefetcher.request(TOKENIZER);
    expect(result.hit).toBe(true);
    await prefetcher.whenIdle();
    expect(loaded.filter((id) => id === 'asset:tokenizer')).toHaveLength(1);
  });
});

describe('createPrefetcher — memory pressure', () => {
  it('skips prefetches under pressure and bounds concurrent prefetches', async () => {
    let pressured = false;
    const { loader } = makeLoader(5);
    const prefetcher = createPrefetcher({
      loader,
      shouldThrottle: () => pressured,
      maxConcurrent: 2,
      targets: [MODEL, TOKENIZER],
      graph: {
        edges: [
          { from: 'model:tiny-q4', to: 'asset:tokenizer' },
          { from: 'asset:tokenizer', to: 'asset:extra' },
        ],
      },
    });

    // Under pressure nothing is prefetched.
    pressured = true;
    const outcome = await prefetcher.prefetch(TOKENIZER);
    expect(outcome).toBe('throttled');
    expect(prefetcher.stats().throttled).toBe(1);
    expect(prefetcher.stats().maxConcurrent).toBe(0);

    // With pressure released, prefetches run but never exceed the cap.
    pressured = false;
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `asset:${i}`, bytes: 10 }));
    const busy = createPrefetcher({
      loader: () => new Promise((resolve) => setTimeout(() => resolve('x'), 20)),
      maxConcurrent: 2,
      targets: many,
    });
    for (const target of many) void busy.prefetch(target);
    await busy.whenIdle();
    expect(busy.stats().maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('drops unclaimed prefetched data under pressure', async () => {
    let pressured = false;
    const { loader } = makeLoader(5);
    const prefetcher = createPrefetcher({
      loader,
      shouldThrottle: () => pressured,
      targets: [MODEL, TOKENIZER],
    });
    await prefetcher.prefetch(TOKENIZER);
    await prefetcher.whenIdle();
    expect(prefetcher.residentIds()).toContain('asset:tokenizer');
    pressured = true;
    await prefetcher.prefetch(MODEL);
    // The unclaimed prefetched copy was released to relieve pressure.
    expect(prefetcher.residentIds()).not.toContain('asset:tokenizer');
  });

  it('keeps the resident prefetch set inside its byte budget', async () => {
    const { loader } = makeLoader(1);
    const prefetcher = createPrefetcher({
      loader,
      residentBudgetBytes: 150,
      targets: [MODEL, TOKENIZER],
    });
    await prefetcher.prefetch(MODEL);
    await prefetcher.prefetch(TOKENIZER);
    await prefetcher.whenIdle();
    expect(prefetcher.stats().residentBytes).toBeLessThanOrEqual(150);
  });
});

describe('createPrefetcher — self-tuning', () => {
  it('disables prefetching when the measured benefit is repeatedly negative', async () => {
    const neverUsed: PrefetchTarget = { id: 'asset:never-used', bytes: 100, kind: 'tokenizer' };
    const { loader } = makeLoader(20);
    const prefetcher = createPrefetcher({
      loader,
      tuning: { disableAfter: 2, minSamples: 2 },
      // The graph predicts a target nobody ever requests, so every prefetch is
      // pure waste: the measured benefit is negative. Drop the unused copy
      // after each idle so the next request prefetches it again (otherwise it
      // stays resident and later windows measure zero waste).
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:never-used' }] },
      targets: [MODEL, neverUsed],
    });
    expect(prefetcher.isEnabled()).toBe(true);

    for (let i = 0; i < 4; i += 1) {
      await prefetcher.request(MODEL);
      await prefetcher.whenIdle();
      prefetcher.cancel('asset:never-used');
    }

    expect(prefetcher.stats().selfTunedOff).toBe(true);
    expect(prefetcher.isEnabled()).toBe(false);
    expect(prefetcher.stats().selfTuneTrips).toBe(1);
  });

  it('keeps prefetching enabled when the measured benefit is positive', async () => {
    const { loader } = makeLoader(20);
    const prefetcher = createPrefetcher({
      loader,
      tuning: { disableAfter: 2, minSamples: 2 },
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:tokenizer' }] },
      targets: [MODEL, TOKENIZER],
    });
    for (let i = 0; i < 4; i += 1) {
      await prefetcher.request(MODEL);
      await prefetcher.whenIdle();
      await prefetcher.request(TOKENIZER);
      await prefetcher.whenIdle();
    }
    expect(prefetcher.stats().selfTunedOff).toBe(false);
    expect(prefetcher.isEnabled()).toBe(true);
  });
});

describe('createPrefetcher — cancellation', () => {
  it('cancels speculative prefetches when the prediction is invalidated', async () => {
    let aborted = false;
    const loader = async (_target: PrefetchTarget, signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal.aborted) {
        aborted = true;
        throw new DOMException('aborted', 'AbortError');
      }
      return 'value';
    };
    const prefetcher = createPrefetcher({
      loader,
      targets: [MODEL, TOKENIZER],
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:tokenizer' }] },
    });
    const controller = new AbortController();
    prefetcher.predict(
      { target: 'model:tiny-q4', profile: { expects: ['asset:tokenizer'] } },
      { signal: controller.signal },
    );
    controller.abort();
    await prefetcher.whenIdle();
    expect(aborted).toBe(true);
    expect(prefetcher.stats().cancelled).toBeGreaterThan(0);
  });

  it('cancelAll stops in-flight speculative loads', async () => {
    let aborted = false;
    const loader = async (_target: PrefetchTarget, signal: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal.aborted) {
        aborted = true;
        throw new DOMException('aborted', 'AbortError');
      }
      return 'value';
    };
    const prefetcher = createPrefetcher({ loader, targets: [MODEL] });
    void prefetcher.prefetch(MODEL);
    prefetcher.cancelAll();
    await prefetcher.whenIdle();
    expect(aborted).toBe(true);
  });

  it('still serves the caller when a joined prefetch is cancelled', async () => {
    const prefetcher = createPrefetcher({
      loader: async (_target: PrefetchTarget, signal: AbortSignal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        return 'value';
      },
      targets: [MODEL],
    });
    void prefetcher.prefetch(MODEL);
    prefetcher.cancelAll();
    const result = await prefetcher.request(MODEL);
    expect(result.value).toBe('value');
    expect(result.hit).toBe(false);
  });
});

describe('streaming — double buffering', () => {
  it('keeps the consumed chunk separate from the chunk being produced', async () => {
    const buffer = createDoubleBuffer<string>();
    buffer.stage('a');
    expect(buffer.hasStaged()).toBe(true);
    expect(buffer.current()).toBeUndefined();
    buffer.swap();
    expect(buffer.current()).toBe('a');
    // Staging the next value does not disturb the consumed one.
    buffer.stage('b');
    expect(buffer.current()).toBe('a');
    expect(buffer.staged()).toBe('b');
    buffer.swap();
    expect(buffer.current()).toBe('b');
  });

  it('pumps a producer through the double buffer without interleaving', async () => {
    const produced: number[] = [];
    async function* produce() {
      for (let i = 0; i < 4; i += 1) {
        produced.push(i);
        yield i;
      }
    }
    const seen: number[] = [];
    for await (const chunk of pumpDoubleBuffer(produce)) {
      seen.push(chunk.value);
      expect(chunk.index).toBe(seen.length - 1);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(produced).toEqual([0, 1, 2, 3]);
  });
});

describe('streaming — prefill streaming', () => {
  it('streams prefill tokens when the backend supports it', async () => {
    const stream = createPrefillStream({
      supportsPrefillStreaming: () => true,
      streamPrefill: async function* () {
        yield { token: 'p0', index: 0 };
        yield { token: 'p1', index: 1, done: true };
      },
      streamDecode: async function* () {
        yield { token: 'd0' };
      },
    });
    const result = await stream.run({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.streamedPrefill).toBe(true);
    expect(result.prefillTokens).toBe(2);
    expect(result.decodeTokens).toBe(1);
  });

  it('degrades gracefully when the backend cannot stream prefill', async () => {
    const stream = createPrefillStream({
      supportsPrefillStreaming: () => false,
      streamDecode: async function* () {
        yield { token: 'd0' };
        yield { token: 'd1' };
      },
    });
    const result = await stream.run({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.streamedPrefill).toBe(false);
    expect(result.prefillTokens).toBe(0);
    // The decode tokens are identical either way — nothing downstream changes.
    expect(result.decodeTokens).toBe(2);
  });

  it('degrades gracefully when the backend has no prefill support at all', async () => {
    const stream = createPrefillStream({
      streamDecode: async function* () {
        yield { token: 'd0' };
      },
    });
    const result = await stream.run({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.streamedPrefill).toBe(false);
    expect(result.decodeTokens).toBe(1);
  });

  it('never throws when the support probe throws', async () => {
    const stream = createPrefillStream({
      supportsPrefillStreaming: () => {
        throw new Error('probe blew up');
      },
      streamDecode: async function* () {
        yield { token: 'd0' };
      },
    });
    const result = await stream.run({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.streamedPrefill).toBe(false);
    expect(result.decodeTokens).toBe(1);
  });
});

describe('createPrefetcher — decoupling', () => {
  it('never calls the loader for a prediction it did not act on', async () => {
    const { loader, loaded } = makeLoader(1);
    const prefetcher = createPrefetcher({
      loader,
      minConfidence: 0.99,
      targets: [MODEL, TOKENIZER],
      graph: { edges: [{ from: 'model:tiny-q4', to: 'asset:tokenizer', weight: 0.01 }] },
    });
    const predictions = prefetcher.predict({ target: 'model:tiny-q4' });
    expect(predictions).toHaveLength(0);
    await prefetcher.whenIdle();
    expect(loaded).toHaveLength(0);
  });

  it('records an explainable event log', async () => {
    const { loader } = makeLoader(1);
    const events: string[] = [];
    const prefetcher = createPrefetcher({
      loader,
      onEvent: (event) => events.push(`${event.id}:${event.outcome}`),
      targets: [MODEL],
    });
    await prefetcher.request(MODEL);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toContain(':loaded');
  });
});
