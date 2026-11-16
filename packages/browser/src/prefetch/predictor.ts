/**
 * Phase 4 — Predictive Prefetching: prediction strategies.
 *
 * Three complementary strategies, all pure and deterministic over their inputs:
 *
 *   1. `static-graph`  — a declared dependency graph ("tokenizer" -> "model").
 *   2. `history`       — next-item prediction over the observed access order.
 *   3. `context`       — the caller's workload profile (model size, stage,
 *                        labels, explicit expectations).
 *
 * Every strategy returns predictions with a confidence in [0, 1]; the
 * prefetcher drops anything below `minConfidence`. A strategy never performs
 * I/O and never decides *when* to run a workload.
 */

import type {
  PrefetchContext,
  PrefetchGraph,
  PrefetchPrediction,
  PrefetchStrategy,
  PrefetchTarget,
} from './types.js';

/** Known targets, indexed by id. */
export type TargetIndex = Map<string, PrefetchTarget>;

function targetFor(index: TargetIndex, id: string): PrefetchTarget {
  const known = index.get(id);
  if (known) return known;
  // Unknown ids are still prefetchable — the loader is the source of truth —
  // but their footprint is unknown (0 bytes) and their confidence is capped.
  return { id, bytes: 0 };
}

/**
 * Static graph strategy: everything reachable from the requested id, ranked by
 * the weakest edge on the path (a min-cut style confidence).
 */
export function predictFromGraph(
  rootId: string,
  graph: PrefetchGraph | undefined,
  index: TargetIndex,
): PrefetchPrediction[] {
  if (!graph || graph.edges.length === 0) return [];
  const out: PrefetchPrediction[] = [];
  const seen = new Set<string>([rootId]);
  const confidence = new Map<string, number>([[rootId, 1]]);

  // Breadth-first so the strongest (shortest) path wins.
  let frontier: string[] = [rootId];
  for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const from of frontier) {
      const fromConfidence = confidence.get(from) ?? 1;
      for (const edge of graph.edges) {
        if (edge.from !== from) continue;
        if (seen.has(edge.to)) continue;
        const weight = clamp01(edge.weight ?? 1);
        const conf = clamp01(fromConfidence * weight);
        seen.add(edge.to);
        confidence.set(edge.to, conf);
        next.push(edge.to);
        out.push({
          target: targetFor(index, edge.to),
          strategy: 'static-graph',
          confidence: conf,
          reason: `static graph: ${from} -> ${edge.to} (depth ${depth + 1})`,
        });
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * History strategy: predict the item most likely to follow the last observed
 * access, using a simple order-1 transition table over the access history.
 *
 * Confidence is the empirical transition probability, damped by how many
 * transitions have been observed for that pair.
 */
export function predictFromHistory(
  history: readonly string[],
  index: TargetIndex,
): PrefetchPrediction[] {
  if (history.length < 2) return [];
  const last = history[history.length - 1];
  if (last === undefined) return [];
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 1; i < history.length; i += 1) {
    const from = history[i - 1];
    const to = history[i];
    if (from !== last || to === undefined) continue;
    counts.set(to, (counts.get(to) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return [];
  const out: PrefetchPrediction[] = [];
  for (const [id, count] of counts) {
    if (id === last) continue;
    const probability = count / total;
    // Damp low-evidence predictions: one observation is a hint, not a fact.
    const confidence = clamp01(probability * (1 - 1 / (total + 1)));
    out.push({
      target: targetFor(index, id),
      strategy: 'history',
      confidence,
      reason: `history: ${count}/${total} accesses followed ${last} with ${id}`,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Context strategy: the caller's workload profile says what will be needed
 * next. Confidence rises with how specific the hint is.
 */
export function predictFromContext(
  context: PrefetchContext,
  index: TargetIndex,
): PrefetchPrediction[] {
  const out: PrefetchPrediction[] = [];
  const profile = context.profile;

  // Explicit expectations are the strongest signal the caller can give.
  for (const id of profile?.expects ?? []) {
    if (id === context.target) continue;
    out.push({
      target: targetFor(index, id),
      strategy: 'context',
      confidence: 1,
      reason: `context: workload explicitly expects ${id}`,
    });
  }

  // Stage progression: prefill -> decode -> postprocess. Predict the next
  // stage's typical companion asset when one is declared.
  const stageExpectation: Record<string, string | undefined> = {
    prefill: 'stage:decode',
    decode: 'stage:postprocess',
    postprocess: undefined,
  };
  const nextStage = profile?.stage ? stageExpectation[profile.stage] : undefined;
  if (nextStage && index.has(nextStage)) {
    out.push({
      target: targetFor(index, nextStage),
      strategy: 'context',
      confidence: 0.6,
      reason: `context: stage ${profile?.stage} implies ${nextStage}`,
    });
  }

  // Labels are a coarse workload fingerprint. Same-label targets are likely.
  const labels = profile?.labels ?? [];
  if (labels.length > 0) {
    for (const candidate of index.values()) {
      const candidateLabels = candidate.meta?.labels;
      if (!Array.isArray(candidateLabels)) continue;
      const overlap = labels.filter((l) => (candidateLabels as unknown[]).includes(l));
      if (overlap.length === 0) continue;
      out.push({
        target: candidate,
        strategy: 'context',
        confidence: clamp01(0.3 + 0.2 * overlap.length),
        reason: `context: shares workload label(s) ${overlap.join(', ')}`,
      });
    }
  }

  return out;
}

/** Merge predictions for one context, keeping the best confidence per target id. */
export function mergePredictions(
  groups: readonly PrefetchPrediction[][],
  minConfidence: number,
): PrefetchPrediction[] {
  const best = new Map<string, PrefetchPrediction>();
  for (const group of groups) {
    for (const prediction of group) {
      if (prediction.confidence < minConfidence) continue;
      const existing = best.get(prediction.target.id);
      if (!existing || prediction.confidence > existing.confidence) {
        best.set(prediction.target.id, prediction);
      }
    }
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

/** Names of the strategies this module implements (for docs/UI). */
export const PREFETCH_STRATEGIES: readonly PrefetchStrategy[] = ['static-graph', 'history', 'context'];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
