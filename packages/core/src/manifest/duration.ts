/** Manifest durations: a whole number and a unit — `500ms`, `30s`, `10m`, `2h`, `1d`. */

const DURATION = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Milliseconds, or undefined when `text` is not a positive duration. */
export function parseDuration(text: string): number | undefined {
  const match = DURATION.exec(text.trim());
  if (!match) return undefined;
  const ms = Number(match[1]) * UNIT_MS[match[2]!]!;
  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}
