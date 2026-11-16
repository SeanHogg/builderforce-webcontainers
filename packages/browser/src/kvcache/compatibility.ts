/**
 * Phase 5 — compatibility key for EXACT-prefix KV reuse.
 *
 * A cache hit is allowed only when model weights, tokenizer, positional
 * config, attention config, AND the exact preceding token prefix all match.
 * Semantic retrieval is never treated as KV reuse.
 */

import type { CompatibilityKey, CompatibilityParts } from './types.js';

const SEP = '\x1f';

export function encodeCompatibilityKey(parts: CompatibilityParts): CompatibilityKey {
  const key = [
    parts.modelId,
    parts.weightsHash,
    parts.tokenizerId,
    parts.positionalConfig,
    parts.attentionConfig,
  ].join(SEP);
  return { ...parts, key };
}

export function parseCompatibilityKey(key: string): CompatibilityParts {
  const [modelId, weightsHash, tokenizerId, positionalConfig, attentionConfig] = key.split(SEP);
  return {
    modelId: modelId ?? '',
    weightsHash: weightsHash ?? '',
    tokenizerId: tokenizerId ?? '',
    positionalConfig: positionalConfig ?? '',
    attentionConfig: attentionConfig ?? '',
  };
}

export function compatibilityEquals(a: CompatibilityParts, b: CompatibilityParts): boolean {
  return (
    a.modelId === b.modelId &&
    a.weightsHash === b.weightsHash &&
    a.tokenizerId === b.tokenizerId &&
    a.positionalConfig === b.positionalConfig &&
    a.attentionConfig === b.attentionConfig
  );
}

/** Longest exact token-prefix match length. 0 when the first token differs. */
export function exactPrefixLength(cached: readonly number[], query: readonly number[]): number {
  const n = Math.min(cached.length, query.length);
  let i = 0;
  while (i < n && cached[i] === query[i]) i++;
  return i;
}
