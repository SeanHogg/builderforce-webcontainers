import type * as TS from 'typescript';

export type DiagnosticCategory = 'error' | 'warning' | 'suggestion' | 'message';

/**
 * One problem, in a shape an editor (or an agent) can act on without the
 * TypeScript API: positions are 1-based like an editor's gutter, and `file` is
 * the project-relative path (`src/App.tsx`), the same key `FlatFiles` uses.
 */
export interface CheckDiagnostic {
  /** Project-relative path; absent for global problems (compiler options, a missing lib). */
  file?: string;
  line: number;
  column: number;
  message: string;
  /** TypeScript's code (2322 for TS2322). */
  code: number;
  category: DiagnosticCategory;
}

const CATEGORIES: Record<number, DiagnosticCategory> = { 0: 'warning', 1: 'error', 2: 'suggestion', 3: 'message' };

export function toCheckDiagnostic(ts: typeof TS, diagnostic: TS.Diagnostic): CheckDiagnostic {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const category = CATEGORIES[diagnostic.category] ?? 'error';
  if (!diagnostic.file || diagnostic.start === undefined) return { line: 1, column: 1, message, code: diagnostic.code, category };
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return { file: diagnostic.file.fileName.replace(/^\//, ''), line: line + 1, column: character + 1, message, code: diagnostic.code, category };
}

/** `src/App.tsx(3,7): error TS2322: Type 'number' is not assignable to type 'string'.` — tsc's own format. */
export function formatDiagnostic(diagnostic: CheckDiagnostic): string {
  const where = diagnostic.file ? `${diagnostic.file}(${diagnostic.line},${diagnostic.column}): ` : '';
  return `${where}${diagnostic.category} TS${diagnostic.code}: ${diagnostic.message}`;
}

/** Stable order (file, then position) and no duplicates — a file in two tsconfig projects reports once. */
export function sortDiagnostics(diagnostics: CheckDiagnostic[]): CheckDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .filter((d) => {
      const key = `${d.file ?? ''}:${d.line}:${d.column}:${d.code}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.file ?? '').localeCompare(b.file ?? '') || a.line - b.line || a.column - b.column);
}
