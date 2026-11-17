/**
 * Phase 5 — KV-cache runtime.
 *
 * Orchestrates paged exact-prefix reuse, quantization-aware execution, and
 * gated advanced decode. The execution engine is mock/injected: generate()
 * simulates prefill+decode cost so tests can assert reuse is cheaper than
 * recompute without real GGUF/ONNX weights.
 */

import { canActivationSparsity, canContinuousBatch, canSpeculative, decodeCost, isEnabled } from './advanced.js';
import { encodeCompatibilityKey } from './compatibility.js';
import { PagedKvCache } from './paged.js';
import {
  bandwidthBytes,
  DEFAULT_QUALITY_TOLERANCE,
  defaultQualityScorer,
  planQuantization,
} from './quant.js';
import type {
  AdvancedCapabilities,
  CompatibilityParts,
  KvCacheRuntime,
  KvCacheRuntimeOptions,
  KvCacheStats,
  KvCostModel,
  KvGenerateRequest,
  KvGenerateResult,
  OptimizationFlag,
  QualityScorer,
} from './types.js';

const DEFAULT_COSTS: KvCostModel = {
  cacheHitPerToken: 0.05,
  computePerToken: 1,
  conversionPerToken: 0.2,
  draftPerToken: 0.15,
  verifyPerToken: 0.25,
};

const DEFAULT_MAX_SESSIONS = 1024;

const DEFAULT_CAPS: AdvancedCapabilities = {
  speculativeDecoding: false,
  continuousBatching: false,
  activationSparsity: false,
  hasDraftModel: false,
  sparsityFraction: 0,
  architecture: 'decoder-transformer',
};

function partsOf(req: KvGenerateRequest): CompatibilityParts {
  return {
    modelId: req.model.id,
    weightsHash: req.model.weightsHash ?? req.model.id,
    tokenizerId: req.tokenizerId,
    positionalConfig: req.positionalConfig,
    attentionConfig: req.attentionConfig,
  };
}

function mockOutput(tokens: readonly number[]): string {
  return tokens.map((t) => String.fromCharCode(97 + (Math.abs(t) % 26))).join('');
}

export function createKvCacheRuntime(options: KvCacheRuntimeOptions = {}): KvCacheRuntime {
  const pageTokens = options.pageTokens ?? 16;
  const layers = options.layers ?? 12;
  const kvDim = options.kvDim ?? 64;
  const bytesPerToken = layers * kvDim * 2; // K+V, fp-ish units
  const maxBytes = options.maxBytes ?? 1 * 1024 * 1024;
  const cache = new PagedKvCache(maxBytes, pageTokens, bytesPerToken);
  const flags: Record<OptimizationFlag, boolean> = {
    prefixCache: options.flags?.prefixCache !== false,
    preconvertQuant: options.flags?.preconvertQuant === true,
    speculativeDecoding: options.flags?.speculativeDecoding === true,
    continuousBatching: options.flags?.continuousBatching === true,
    activationSparsity: options.flags?.activationSparsity === true,
  };
  const caps: AdvancedCapabilities = { ...DEFAULT_CAPS, ...options.capabilities };
  const costs: KvCostModel = { ...DEFAULT_COSTS, ...options.costs };
  const scorer: QualityScorer = options.qualityScorer ?? defaultQualityScorer;
  const qualityBaseline = options.qualityBaseline ?? 'fp16';
  const qualityTolerance = options.qualityTolerance ?? DEFAULT_QUALITY_TOLERANCE;
  const draftLen = options.draftLen ?? 4;
  const draftAccuracy = options.draftAccuracy ?? 0.8;
  const preconvertTo = options.preconvertTo ?? 'q4';
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  // Recently seen session ids, least recently seen first (Map insertion order).
  const sessions = new Map<string, true>();

  function noteSession(sessionId: string): void {
    sessions.delete(sessionId);
    sessions.set(sessionId, true);
    for (const oldest of sessions.keys()) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(oldest);
    }
  }

  function generateOne(request: KvGenerateRequest, batchShare = 1): KvGenerateResult {
    const compat = partsOf(request);
    const encoded = encodeCompatibilityKey(compat);
    if (request.sessionId) noteSession(request.sessionId);

    const quantPlan = planQuantization({
      native: request.model.quantization,
      backend: 'mock',
      preconvert: flags.preconvertQuant,
      preconvertTo,
    });

    const applied: OptimizationFlag[] = [];
    let cachedTokens = 0;
    let servedFromCache = false;
    let evictedPages = 0;

    if (flags.prefixCache) {
      applied.push('prefixCache');
      const hit = cache.lookup(compat, request.tokens);
      if (hit.compatKey === encoded.key && hit.matched > 0) {
        cachedTokens = hit.matched;
        servedFromCache = true;
      }
    }

    const computeTokens = Math.max(0, request.tokens.length - cachedTokens) + (request.maxNewTokens ?? 0);
    const speculative = flags.speculativeDecoding && canSpeculative(caps);
    const sparsity = flags.activationSparsity && canActivationSparsity(caps);

    const decode = decodeCost({
      tokens: computeTokens,
      computePerToken: costs.computePerToken,
      speculative,
      sparsity,
      draftLen,
      draftAccuracy,
      draftPerToken: costs.draftPerToken,
      verifyPerToken: costs.verifyPerToken,
      sparsityFraction: caps.sparsityFraction,
    });
    for (const f of decode.applied) if (!applied.includes(f)) applied.push(f);

    const hitCost = cachedTokens * costs.cacheHitPerToken;
    const convertCost = quantPlan.converted ? request.tokens.length * costs.conversionPerToken : 0;
    if (quantPlan.converted) applied.push('preconvertQuant');

    const simulatedMs = (hitCost + decode.cost + convertCost) * batchShare;
    const params = (request.model.paramsB ?? 1.1) * 1e9;
    const bw = bandwidthBytes(params, quantPlan, request.tokens.length, kvDim);

    const output = request.output ?? mockOutput(request.tokens);
    const baselineOutput = request.baselineOutput ?? output;
    const qualityScore = scorer({
      output,
      baselineOutput,
      quantization: quantPlan.runtime,
      baselineQuantization: qualityBaseline,
    });
    const withinTolerance = qualityScore >= 1 - qualityTolerance;

    if (flags.prefixCache) {
      const put = cache.put(compat, request.tokens);
      evictedPages = put.evicted;
    }

    return {
      output,
      compatibilityKey: encoded.key,
      cachedTokens,
      computeTokens,
      simulatedMs,
      bandwidthBytes: bw,
      qualityScore,
      withinTolerance,
      servedFromCache,
      optimizationsApplied: applied,
      evictedPages,
      quantPlan,
    };
  }

  return {
    async generate(request) {
      return generateOne(request, 1);
    },

    async generateBatch(requests) {
      if (requests.length === 0) return [];
      const continuous = flags.continuousBatching && canContinuousBatch(caps) && requests.length > 1;
      if (!continuous) {
        const out: KvGenerateResult[] = [];
        for (const r of requests) out.push(generateOne(r, 1));
        return out;
      }
      // Shared decode step: each request pays max(seq) / n of the batch cost
      // so the sum is demonstrably cheaper than sequential generate().
      const maxTokens = requests.reduce((m, r) => Math.max(m, r.tokens.length + (r.maxNewTokens ?? 0)), 0);
      const sequential = requests.reduce((s, r) => s + (r.tokens.length + (r.maxNewTokens ?? 0)), 0);
      const share = sequential === 0 ? 1 : maxTokens / sequential;
      return requests.map((r) => {
        const result = generateOne(r, share);
        if (!result.optimizationsApplied.includes('continuousBatching')) {
          result.optimizationsApplied.push('continuousBatching');
        }
        return result;
      });
    },

    lookup(request) {
      const compat = partsOf(request);
      const hit = cache.lookup(compat, request.tokens);
      return { matched: hit.matched, key: hit.compatKey };
    },

    setEnabled(flag, enabled) {
      flags[flag] = enabled;
    },

    isEnabled(flag) {
      return isEnabled(flags, flag);
    },

    stats(): KvCacheStats {
      return {
        hits: cache.hits,
        misses: cache.misses,
        pages: cache.pages,
        bytes: cache.bytes,
        evictions: cache.evictions,
        sessions: sessions.size,
      };
    },

    clear() {
      cache.clear();
      sessions.clear();
    },
  };
}
