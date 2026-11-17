/**
 * The ONE token-count heuristic used where no tokenizer is available:
 * ~4 characters per token, the usual English/code budgeting average.
 * An empty string is 0 tokens; callers that need a floor apply it.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
