/**
 * PHP source literals the runtime generates — the `php -S` front script's
 * `-d` settings, Composer's autoload maps — from one escaping rule.
 */

/** A single-quoted PHP string literal: only `\` and `'` need escaping there. */
export const phpString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A PHP literal for JSON-shaped data; `expression` may write a string as a PHP expression instead (`$baseDir . '/src'`). */
export function phpLiteral(value: unknown, expression?: (text: string) => string | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return expression?.(value) ?? phpString(value);
  if (Array.isArray(value)) return `[${value.map((item) => phpLiteral(item, expression)).join(', ')}]`;
  return `[${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${phpLiteral(key)} => ${phpLiteral(item, expression)}`).join(', ')}]`;
}
