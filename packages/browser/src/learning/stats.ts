/**
 * Running mean/variance (Welford). Pure, deterministic, no allocations beyond the struct.
 */

export interface RunningStat {
  n: number;
  mean: number;
  /** Sum of squares of differences from the running mean (Welford M2). */
  m2: number;
}

export function emptyStat(): RunningStat {
  return { n: 0, mean: 0, m2: 0 };
}

export function observeStat(stat: RunningStat, value: number): void {
  stat.n += 1;
  const delta = value - stat.mean;
  stat.mean += delta / stat.n;
  const delta2 = value - stat.mean;
  stat.m2 += delta * delta2;
}

/** Sample variance. 0 until two observations exist. */
export function variance(stat: RunningStat): number {
  if (stat.n < 2) return 0;
  return stat.m2 / (stat.n - 1);
}

/**
 * UCB1 on a reward in (0, 1], where reward = 1 / (1 + mean cost).
 * Unsampled arms return +Infinity so they are explored before exploitation.
 */
export function ucb1(stat: RunningStat, totalN: number): number {
  if (stat.n <= 0) return Number.POSITIVE_INFINITY;
  const reward = 1 / (1 + Math.max(0, stat.mean));
  const bonus = Math.sqrt((2 * Math.log(Math.max(totalN, 1))) / stat.n);
  return reward + bonus;
}
