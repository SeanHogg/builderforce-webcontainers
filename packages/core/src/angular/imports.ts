import { maskCode, skipString } from './scanner.js';
import { stringLiteralValue } from './syntax.js';

/**
 * A module's static `import` declarations, read over masked code (see
 * scanner.ts) — how the Angular transforms learn which local names ARE
 * Angular's: `input` only when it was imported from `@angular/core` (under any
 * alias, or as `ng.input` through a namespace import), and which names exist
 * only as types (`import type { X }`, `import { type X }`) and so have no value
 * at runtime.
 */
export interface ImportBinding {
  /** The exported name; `'default'` for a default import, `'*'` for a namespace import. */
  imported: string;
  local: string;
  /** `import type …` or `import { type X }`: no runtime value. */
  typeOnly: boolean;
}

export interface ImportDeclaration {
  module: string;
  bindings: ImportBinding[];
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** `import <clause> from '…'`; the clause is code (it holds no strings), the module a literal. */
const IMPORT = /(?<![\w$.])import\s+(type\s+)?([\w$*{}\s,]*?)\s*\bfrom\s*(?=["'])/g;

function namedBindings(list: string, typeOnly: boolean): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const raw of list.split(',')) {
    const m = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(raw);
    if (!m) continue;
    out.push({ imported: m[2]!, local: m[3] ?? m[2]!, typeOnly: typeOnly || !!m[1] });
  }
  return out;
}

function clauseBindings(clause: string, typeOnly: boolean): ImportBinding[] {
  const out: ImportBinding[] = [];
  let rest = clause.trim();
  const named = /\{([^}]*)\}/.exec(rest);
  if (named) {
    out.push(...namedBindings(named[1]!, typeOnly));
    rest = rest.replace(named[0], '');
  }
  const namespace = /\*\s*as\s+([\w$]+)/.exec(rest);
  if (namespace) {
    out.push({ imported: '*', local: namespace[1]!, typeOnly });
    rest = rest.replace(namespace[0], '');
  }
  const fallback = rest.replace(/,/g, ' ').trim();
  if (IDENTIFIER.test(fallback)) out.push({ imported: 'default', local: fallback, typeOnly });
  return out;
}

export function readImports(source: string, masked: string): ImportDeclaration[] {
  const out: ImportDeclaration[] = [];
  for (const m of masked.matchAll(IMPORT)) {
    const quote = m.index + m[0].length;
    const module = stringLiteralValue(source.slice(quote, skipString(source, quote)));
    if (module === undefined) continue;
    out.push({ module, bindings: clauseBindings(m[2]!, !!m[1]) });
  }
  return out;
}

/**
 * One module as the transforms see it: masked ONCE, imports read once. Every
 * transform computes its edits against the same original text, and the compiler
 * applies them together (so no transform re-masks another's output).
 */
export interface ScannedSource {
  source: string;
  masked: string;
  imports: ImportDeclaration[];
}

export function scanSource(source: string): ScannedSource {
  const masked = maskCode(source);
  return { source, masked, imports: readImports(source, masked) };
}

/**
 * How `module`'s value exports are named in this file: local name → exported
 * name for named imports, and the namespaces (`import * as ng`) it is reachable
 * through.
 */
export interface ModuleValues {
  named: Map<string, string>;
  namespaces: string[];
}

export function valuesFrom(imports: readonly ImportDeclaration[], module: string): ModuleValues {
  const named = new Map<string, string>();
  const namespaces: string[] = [];
  for (const declaration of imports) {
    if (declaration.module !== module) continue;
    for (const binding of declaration.bindings) {
      if (binding.typeOnly) continue;
      if (binding.imported === '*') namespaces.push(binding.local);
      else named.set(binding.local, binding.imported);
    }
  }
  return { named, namespaces };
}

/** Local names imported only as types, from any module. */
export function typeOnlyNames(imports: readonly ImportDeclaration[]): Set<string> {
  const out = new Set<string>();
  for (const declaration of imports) for (const binding of declaration.bindings) if (binding.typeOnly) out.add(binding.local);
  return out;
}

/**
 * The exported name an expression (`Inject`, an alias of it, `ng.Inject`) refers
 * to when it is one of `module`'s value exports; undefined otherwise.
 */
export function exportNamed(values: ModuleValues, expression: string): string | undefined {
  const parts = expression.split('.').map((part) => part.trim());
  if (parts.length === 1) return values.named.get(parts[0]!);
  if (parts.length === 2 && values.namespaces.includes(parts[0]!)) return parts[1];
  return undefined;
}

/** Regex source matching any local spelling of `names` from `values` (`input`, `i`, `ng.input`), whole words. */
export function spellingsOf(values: ModuleValues, names: readonly string[]): { source: string; nameOf: (spelling: string) => string | undefined } | undefined {
  const escape = (text: string) => text.replace(/\$/g, '\\$');
  const spellings: string[] = [];
  for (const [local, imported] of values.named) if (names.includes(imported)) spellings.push(escape(local));
  for (const namespace of values.namespaces) spellings.push(`${escape(namespace)}\\s*\\.\\s*(?:${names.join('|')})`);
  if (!spellings.length) return undefined;
  return {
    source: `(?<![\\w$.])(?:${spellings.join('|')})(?![\\w$])`,
    nameOf: (spelling) => {
      const name = exportNamed(values, spelling.replace(/\s+/g, ''));
      return name !== undefined && names.includes(name) ? name : undefined;
    },
  };
}
