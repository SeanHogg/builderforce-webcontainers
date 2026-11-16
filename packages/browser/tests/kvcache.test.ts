import { describe, expect, it } from 'vitest';
import {
  canActivationSparsity,
  canContinuousBatch,
  canSpeculative,
  decodeCost,
} from '../src/kvcache/advanced.js';
import {
  compatibilityEquals,
  encodeCompatibilityKey,
  exactPrefixLength,
} from '../src/kvcache/compatibility.js';
import { LruCache } from '../src/kvcache/lru.js';
import { planQuantization } from '../src/kvcache/quant.js';
import { TokenRadix } from '../src/kvcache/radix.js';
import { createKvCacheRuntime } from '../src/kvcache/runtime.js';
import type { AdvancedCapabilities, KvGenerateRequest } from '../src/kvcache/types.js';

const MODEL = { id: 'tiny-instruct', quantization: 'q4' as const, paramsB: 1.1, weightsHash: 'w1' };

const CAPS: AdvancedCapabilities = {
  speculativeDecoding: true,
  continuousBatching: true,
  activationSparsity: true,
  hasDraftModel: true,
  sparsityFraction: 0.5,
  architecture: 'decoder-transformer',
};

function req(over: Partial<KvGenerateRequest> = {}): KvGenerateRequest {
  return {
    tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    maxNewTokens: 0,
    model: MODEL,
    tokenizerId: 'tok-v1',
    positionalConfig: 'rope:theta=10000:scale=1',
    attentionConfig: 'mha:heads=32:kvHeads=8:headDim=64',
    sessionId: 's1',
    ...over,
  };
}

describe('compatibility key', () => {
  it('encodes all five parts and treats a mismatch as unequal', () => {
    const a = encodeCompatibilityKey({
      modelId: 'm',
      weightsHash: 'w',
      tokenizerId: 't',
      positionalConfig: 'p',
      attentionConfig: 'a',
    });
    const b = encodeCompatibilityKey({
      modelId: 'm',
      weightsHash: 'w-other',
      tokenizerId: 't',
      positionalConfig: 'p',
      attentionConfig: 'a',
    });
    expect(a.key).not.toBe(b.key);
    expect(compatibilityEquals(a, b)).toBe(false);
    expect(compatibilityEquals(a, a)).toBe(true);
  });

  it('exactPrefixLength stops at the first mismatch', () => {
    expect(exactPrefixLength([1, 2, 3], [1, 2, 3, 4])).toBe(3);
    expect(exactPrefixLength([1, 2, 9], [1, 2, 3])).toBe(2);
    expect(exactPrefixLength([9, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe('radix + lru primitives', () => {
  it('finds the longest exact token prefix and nothing semantic', () => {
    const tree = new TokenRadix<string>();
    tree.insert([1, 2, 3], 'a');
    tree.insert([1, 2, 3, 4, 5], 'b');
    expect(tree.longestPrefix([1, 2, 3, 4, 5, 6])?.value).toBe('b');
    expect(tree.longestPrefix([1, 2, 9])).toBeUndefined();
    expect(tree.longestPrefix([9, 1, 2])).toBeUndefined();
  });

  it('evicts least-recently-used entries when over capacity', () => {
    const lru = new LruCache<string>(10);
    lru.set('a', 'A', 6);
    lru.set('b', 'B', 6);
    expect(lru.has('a')).toBe(false);
    expect(lru.get('b')).toBe('B');
  });
});

describe('createKvCacheRuntime — exact-prefix reuse', () => {
  it('reuses an exact prefix faster than recompute', async () => {
    const rt = createKvCacheRuntime({ flags: { prefixCache: true } });
    const first = await rt.generate(req());
    const second = await rt.generate(req({ tokens: [...req().tokens, 17, 18, 19, 20] }));
    expect(first.servedFromCache).toBe(false);
    expect(second.servedFromCache).toBe(true);
    expect(second.cachedTokens).toBe(16);
    expect(second.simulatedMs).toBeLessThan(first.simulatedMs);
    expect(second.computeTokens).toBeLessThan(first.computeTokens + 4);
  });

  it('never serves KV from cache when the compatibility key mismatches', async () => {
    const rt = createKvCacheRuntime({ flags: { prefixCache: true } });
    await rt.generate(req());
    const mismatches: KvGenerateRequest[] = [
      req({ model: { ...MODEL, weightsHash: 'other-weights' } }),
      req({ tokenizerId: 'tok-v2' }),
      req({ positionalConfig: 'alibi' }),
      req({ attentionConfig: 'gqa:heads=16' }),
      req({ model: { ...MODEL, id: 'other-model' } }),
    ];
    for (const m of mismatches) {
      const result = await rt.generate(m);
      expect(result.servedFromCache).toBe(false);
      expect(result.cachedTokens).toBe(0);
      expect(result.compatibilityKey).not.toBe((await rt.generate(req())).compatibilityKey);
    }
  });

  it('reuses KV across compatible sessions (session id is not part of the key)', async () => {
    const rt = createKvCacheRuntime({ flags: { prefixCache: true } });
    await rt.generate(req({ sessionId: 'alpha' }));
    const b = await rt.generate(req({ sessionId: 'beta' }));
    expect(b.servedFromCache).toBe(true);
    expect(rt.stats().sessions).toBe(2);
  });
});

describe('quality baseline (injectable scorer)', () => {
  it('stays within tolerance for the default scorer on a matching output', async () => {
    const rt = createKvCacheRuntime({ qualityTolerance: 0.08, qualityBaseline: 'fp16' });
    const result = await rt.generate(req({ output: 'hello', baselineOutput: 'hello' }));
    expect(result.withinTolerance).toBe(true);
    expect(result.qualityScore).toBeGreaterThanOrEqual(1 - 0.08);
  });

  it('uses an injected scorer so a test can assert the tolerance gate', async () => {
    const pass = createKvCacheRuntime({
      qualityTolerance: 0.1,
      qualityScorer: () => 0.95,
    });
    const fail = createKvCacheRuntime({
      qualityTolerance: 0.1,
      qualityScorer: () => 0.5,
    });
    expect((await pass.generate(req())).withinTolerance).toBe(true);
    expect((await fail.generate(req())).withinTolerance).toBe(false);
  });
});

describe('A/B toggles — every optimization on vs off', () => {
  it('prefixCache on is faster than prefixCache off on a repeated prompt', async () => {
    const on = createKvCacheRuntime({ flags: { prefixCache: true } });
    const off = createKvCacheRuntime({ flags: { prefixCache: false } });
    await on.generate(req());
    await off.generate(req());
    const onHit = await on.generate(req());
    const offMiss = await off.generate(req());
    expect(on.isEnabled('prefixCache')).toBe(true);
    expect(off.isEnabled('prefixCache')).toBe(false);
    expect(onHit.simulatedMs).toBeLessThan(offMiss.simulatedMs);
    expect(onHit.servedFromCache).toBe(true);
    expect(offMiss.servedFromCache).toBe(false);
  });

  it('speculative decoding on is cheaper than off when capable', async () => {
    const on = createKvCacheRuntime({
      flags: { prefixCache: false, speculativeDecoding: true },
      capabilities: CAPS,
      draftAccuracy: 1,
    });
    const off = createKvCacheRuntime({
      flags: { prefixCache: false, speculativeDecoding: false },
      capabilities: CAPS,
    });
    const a = await on.generate(req({ maxNewTokens: 16 }));
    const b = await off.generate(req({ maxNewTokens: 16 }));
    expect(a.optimizationsApplied).toContain('speculativeDecoding');
    expect(b.optimizationsApplied).not.toContain('speculativeDecoding');
    expect(a.simulatedMs).toBeLessThan(b.simulatedMs);
  });

  it('activation sparsity on is cheaper than off when capable', async () => {
    const on = createKvCacheRuntime({
      flags: { prefixCache: false, activationSparsity: true },
      capabilities: CAPS,
    });
    const off = createKvCacheRuntime({
      flags: { prefixCache: false, activationSparsity: false },
      capabilities: CAPS,
    });
    const a = await on.generate(req());
    const b = await off.generate(req());
    expect(a.optimizationsApplied).toContain('activationSparsity');
    expect(b.optimizationsApplied).not.toContain('activationSparsity');
    expect(a.simulatedMs).toBeLessThan(b.simulatedMs);
  });

  it('continuous batching on is cheaper than sequential generate', async () => {
    const on = createKvCacheRuntime({
      flags: { prefixCache: false, continuousBatching: true },
      capabilities: CAPS,
    });
    const off = createKvCacheRuntime({
      flags: { prefixCache: false, continuousBatching: false },
      capabilities: CAPS,
    });
    const batch = [req({ tokens: [1, 2, 3, 4, 5, 6, 7, 8] }), req({ tokens: [9, 10, 11, 12, 13, 14, 15, 16] })];
    const batched = await on.generateBatch(batch);
    const sequential = await off.generateBatch(batch);
    const onSum = batched.reduce((s, r) => s + r.simulatedMs, 0);
    const offSum = sequential.reduce((s, r) => s + r.simulatedMs, 0);
    expect(batched[0]?.optimizationsApplied).toContain('continuousBatching');
    expect(sequential[0]?.optimizationsApplied).not.toContain('continuousBatching');
    expect(onSum).toBeLessThan(offSum);
  });

  it('preconvertQuant on reduces bandwidth vs native fp16 and records the conversion', async () => {
    const on = createKvCacheRuntime({
      flags: { prefixCache: false, preconvertQuant: true },
      preconvertTo: 'q4',
    });
    const off = createKvCacheRuntime({ flags: { prefixCache: false, preconvertQuant: false } });
    const fp16 = req({ model: { ...MODEL, quantization: 'fp16' } });
    const a = await on.generate(fp16);
    const b = await off.generate(fp16);
    expect(a.quantPlan.converted).toBe(true);
    expect(b.quantPlan.converted).toBe(false);
    expect(a.bandwidthBytes).toBeLessThan(b.bandwidthBytes);
    expect(a.optimizationsApplied).toContain('preconvertQuant');
  });
});

describe('capability / architecture gates', () => {
  it('degrades to the plain path when the architecture is incompatible', async () => {
    const rt = createKvCacheRuntime({
      flags: {
        prefixCache: false,
        speculativeDecoding: true,
        continuousBatching: true,
        activationSparsity: true,
      },
      capabilities: { ...CAPS, architecture: 'encoder-bert' },
    });
    const result = await rt.generate(req({ maxNewTokens: 8 }));
    expect(result.optimizationsApplied).not.toContain('speculativeDecoding');
    expect(result.optimizationsApplied).not.toContain('activationSparsity');
    const batched = await rt.generateBatch([req(), req({ tokens: [99, 100] })]);
    expect(batched[0]?.optimizationsApplied).not.toContain('continuousBatching');
  });

  it('refuses speculative decoding without a draft model even when the flag is on', () => {
    expect(canSpeculative({ ...CAPS, hasDraftModel: false })).toBe(false);
    expect(canSpeculative(CAPS)).toBe(true);
    expect(canContinuousBatch({ ...CAPS, architecture: 'encoder-bert' })).toBe(false);
    expect(canActivationSparsity({ ...CAPS, sparsityFraction: 0 })).toBe(false);
  });

  it('decodeCost with speculative is strictly below the dense path', () => {
    const dense = decodeCost({
      tokens: 16,
      computePerToken: 1,
      speculative: false,
      sparsity: false,
      draftLen: 4,
      draftAccuracy: 1,
      draftPerToken: 0.15,
      verifyPerToken: 0.25,
      sparsityFraction: 0,
    });
    const spec = decodeCost({
      tokens: 16,
      computePerToken: 1,
      speculative: true,
      sparsity: false,
      draftLen: 4,
      draftAccuracy: 1,
      draftPerToken: 0.15,
      verifyPerToken: 0.25,
      sparsityFraction: 0,
    });
    expect(spec.cost).toBeLessThan(dense.cost);
    expect(spec.applied).toContain('speculativeDecoding');
  });
});

describe('quantization-aware execution', () => {
  it('does not convert unless preconvert is justified', () => {
    const native = planQuantization({ native: 'q4', backend: 'mock', preconvert: false });
    expect(native.converted).toBe(false);
    expect(native.runtime).toBe('q4');
    const unjustified = planQuantization({ native: 'q4', backend: 'mock', preconvert: true, preconvertTo: 'fp16' });
    expect(unjustified.converted).toBe(false);
    const justified = planQuantization({ native: 'fp16', backend: 'mock', preconvert: true, preconvertTo: 'q4' });
    expect(justified.converted).toBe(true);
    expect(justified.runtime).toBe('q4');
  });
});
