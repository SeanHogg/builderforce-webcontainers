import { describe, expect, it } from 'vitest';
import { createPrefetcher } from '../src/prefetch/prefetcher.js';
import type { PrefetchTarget } from '../src/prefetch/types.js';

function makeLoader(delayMs = 1) {
  const loaded: string[] = [];
  const loader = async (target: PrefetchTarget, signal: AbortSignal) => {
    loaded.push(target.id);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    return `value:${target.id}`;
  };
  return { loader, loaded };
}

const A: PrefetchTarget = { id: 'asset:a', bytes: 100 };
const B: PrefetchTarget = { id: 'asset:b', bytes: 100 };

describe('Prefetcher.release', () => {
  it('drops a demand-loaded value and reports whether something was dropped', async () => {
    const { loader } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A] });
    await prefetcher.request(A);
    expect(prefetcher.residentIds()).toContain(A.id);
    expect(prefetcher.stats().residentBytes).toBe(100);

    expect(prefetcher.release(A.id)).toBe(true);
    expect(prefetcher.residentIds()).not.toContain(A.id);
    expect(prefetcher.stats().residentBytes).toBe(0);
    expect(prefetcher.release(A.id)).toBe(false);

    // Released data is no longer a hit.
    const again = await prefetcher.request(A);
    expect(again.hit).toBe(false);
  });

  it('drops claimed and unclaimed prefetched values', async () => {
    const { loader } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A, B] });
    await prefetcher.prefetch(A);
    await prefetcher.prefetch(B);
    await prefetcher.request(A); // claims A
    expect(prefetcher.release(A.id)).toBe(true);
    expect(prefetcher.release(B.id)).toBe(true);
    expect(prefetcher.residentIds()).toEqual([]);
    expect(prefetcher.release('asset:never-seen')).toBe(false);
  });
});

describe('Prefetcher — already-aborted signals', () => {
  it('never runs the loader for a prefetch whose signal is aborted before the call', async () => {
    const { loader, loaded } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A] });
    const controller = new AbortController();
    controller.abort();
    const outcome = await prefetcher.prefetch(A, { signal: controller.signal });
    expect(outcome).toBe('cancelled');
    expect(loaded).toEqual([]);
    expect(prefetcher.stats().cancelled).toBe(1);
    expect(prefetcher.residentIds()).not.toContain(A.id);
    await prefetcher.whenIdle();
    expect(prefetcher.stats().inFlight).toBe(0);
  });

  it('rejects a request whose signal is aborted before the call without loading', async () => {
    const { loader, loaded } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A] });
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await prefetcher.request(A, { signal: controller.signal }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect((error as { name?: string } | undefined)?.name).toBe('AbortError');
    expect(loaded).toEqual([]);
  });
});

describe('Prefetcher — bounded resident store', () => {
  it('keeps demand-loaded values inside the byte budget', async () => {
    const { loader } = makeLoader();
    const targets = Array.from({ length: 6 }, (_, i) => ({ id: `asset:${i}`, bytes: 100 }));
    const prefetcher = createPrefetcher({ loader, targets, residentBudgetBytes: 250, enabled: false });
    for (const target of targets) {
      await prefetcher.request(target);
      expect(prefetcher.stats().residentBytes).toBeLessThanOrEqual(250);
    }
    // The most recently used values survive; the oldest demand loads were evicted.
    expect(prefetcher.residentIds()).toEqual(['asset:4', 'asset:5']);
  });

  it('caps the number of resident values even without a byte budget', async () => {
    const { loader } = makeLoader();
    const targets = Array.from({ length: 10 }, (_, i) => ({ id: `asset:${i}`, bytes: 1 }));
    const prefetcher = createPrefetcher({ loader, targets, maxResidentEntries: 3, enabled: false });
    for (const target of targets) await prefetcher.request(target);
    expect(prefetcher.residentIds()).toHaveLength(3);
  });

  it('evicts unclaimed prefetches before claimed demand data', async () => {
    const { loader } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A, B], residentBudgetBytes: 150 });
    await prefetcher.request(A); // demand, claimed
    await prefetcher.prefetch(B); // speculative, unclaimed, pushes the store over budget
    await prefetcher.whenIdle();
    expect(prefetcher.residentIds()).toEqual([A.id]);
  });

  it('forgets runtime-learned targets beyond maxKnownTargets', async () => {
    const { loader } = makeLoader();
    // Speculation off so only the requested loads touch the resident store.
    const prefetcher = createPrefetcher({ loader, maxKnownTargets: 1, enabled: false });
    await prefetcher.request(A);
    await prefetcher.request(B); // A is forgotten from the target index
    prefetcher.release(A.id);
    prefetcher.release(B.id);
    // A forgotten target's metadata is gone: requesting it by id alone is rejected
    // rather than loaded with an unknown footprint that escapes the byte budget.
    await expect(prefetcher.requestById(A.id)).rejects.toThrow(/unknown prefetch target/);
    expect(prefetcher.stats().residentBytes).toBe(0);
    // Supplying the target relearns it and makes it resident at its real footprint.
    const reloaded = await prefetcher.request(A);
    expect(reloaded.hit).toBe(false);
    expect(prefetcher.residentIds()).toEqual([A.id]);
    expect(prefetcher.stats().residentBytes).toBe(100);
    // Relearning A forgot B (cap 1); A is known again and now a hit by id.
    await expect(prefetcher.requestById(B.id)).rejects.toThrow(/unknown prefetch target/);
    expect((await prefetcher.requestById(A.id)).hit).toBe(true);
  });
});

describe('Prefetcher — speculation is limited to known targets', () => {
  it("refuses a history prediction of a forgotten id with 'unknown-target' and loads nothing", async () => {
    const { loader, loaded } = makeLoader();
    const prefetcher = createPrefetcher({ loader, maxKnownTargets: 1 });
    await prefetcher.request(A);
    await prefetcher.request(B); // A forgotten
    prefetcher.release(B.id); // so a speculative reload of B would show up
    // Still resident (forgetting drops metadata only) ⇒ a hit; B is forgotten and
    // history [A, B, A] predicts B.
    expect((await prefetcher.request(A)).hit).toBe(true);
    await prefetcher.whenIdle();
    expect(loaded).toEqual([A.id, B.id]); // the two demand loads; nothing speculative
    expect(prefetcher.residentIds()).not.toContain(B.id);
    const refused = prefetcher.events().filter((e) => e.id === B.id && e.skipReason === 'unknown-target');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.outcome).toBe('skipped');
  });

  it("refuses a context prediction of a never-declared id with 'unknown-target'", async () => {
    const { loader, loaded } = makeLoader();
    const prefetcher = createPrefetcher({ loader, targets: [A] });
    const acted = prefetcher.predict({ target: A.id, profile: { expects: ['asset:never-declared'] } });
    await prefetcher.whenIdle();
    expect(acted.map((p) => p.target.id)).not.toContain('asset:never-declared');
    expect(loaded).not.toContain('asset:never-declared');
    expect(prefetcher.events().some((e) => e.id === 'asset:never-declared' && e.skipReason === 'unknown-target')).toBe(true);
  });

  it('an explicit prefetch(target) of an undeclared target is still admitted', async () => {
    const { loader, loaded } = makeLoader();
    const prefetcher = createPrefetcher({ loader });
    expect(await prefetcher.prefetch(B)).toBe('loaded');
    expect(loaded).toEqual([B.id]);
    expect(prefetcher.stats().residentBytes).toBe(100);
  });
});
