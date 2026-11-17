import { describe, expect, it } from 'vitest';
import { createLearner } from '../src/learning/learner.js';

const SIG = 'p1-3|q:q4|prompt:0-128|decode:0-64';

function exploringLearner(historyLimit?: number) {
  // rng 0 < epsilon: every recommendation explores the alternative, so every apply is a change.
  const learner = createLearner({ rng: () => 0, epsilon: 0.1, clock: () => 1, historyLimit });
  learner.register({ id: 'cpu-only', validated: true });
  learner.register({ id: 'fast', validated: true });
  return learner;
}

describe('createLearner — bounded history', () => {
  it('caps history at historyLimit, dropping the oldest changes', () => {
    const learner = exploringLearner(5);
    for (let i = 0; i < 20; i++) {
      expect(learner.apply(learner.recommend(SIG, 'cpu-only'))).not.toBeNull();
    }
    expect(learner.history()).toHaveLength(5);
    // Rollback still works over the retained window, then runs out.
    for (let i = 0; i < 5; i++) expect(learner.rollback()).not.toBeNull();
    expect(learner.rollback()).toBeNull();
  });

  it('defaults the history cap to 256', () => {
    const learner = exploringLearner();
    for (let i = 0; i < 300; i++) learner.apply(learner.recommend(SIG, 'cpu-only'));
    expect(learner.history()).toHaveLength(256);
  });
});
