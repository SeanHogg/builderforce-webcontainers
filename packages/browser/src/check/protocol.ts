/**
 * Messages between `createChecker()` (page) and the check worker. Files travel as
 * strings: only source and config files are sent, never assets.
 */
import type { TypeSources, TypecheckResult } from '@seanhogg/builderforce-webcontainers-core/check';

export const CHECK = 'bfwc:check';
export const CHECK_RESULT = 'bfwc:check-result';
export const CHECK_ERROR = 'bfwc:check-error';

export interface CheckRequest {
  type: typeof CHECK;
  id: number;
  files: Record<string, string>;
  /** Classic script URL of the TypeScript compiler (sets `self.ts`). */
  typescriptUrl: string;
  sources?: Partial<TypeSources>;
}

export type CheckReply =
  | { type: typeof CHECK_RESULT; id: number; result: TypecheckResult; durationMs: number }
  | { type: typeof CHECK_ERROR; id: number; message: string };

/** Paths whose contents can affect type-checking. */
const CHECKED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/i;

export function isCheckInput(path: string): boolean {
  return CHECKED.test(path) && !/(^|\/)(node_modules|dist)\//.test(path);
}

export function isCheckReply(value: unknown): value is CheckReply {
  const v = value as CheckReply | null;
  return !!v && (v.type === CHECK_RESULT || v.type === CHECK_ERROR) && typeof v.id === 'number';
}
