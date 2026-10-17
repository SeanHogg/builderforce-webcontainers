import { init, parse } from 'es-module-lexer';
import { contentHash } from '../hash.js';
import type { ProjectConfig } from '../projectConfig.js';
import type { ModuleFacts } from './moduleGraph.js';

/**
 * React Fast Refresh without Babel. The official runtime (`react-refresh/runtime`)
 * does the hard part — swapping a component's implementation while React keeps
 * its state — and only needs two things from the compiler:
 *
 *   • each component REGISTERED under a stable id when its module runs, which
 *     the dev server appends to compiled modules (`refreshFooter`);
 *   • to know when a component's hooks changed, because state cannot carry
 *     across a different hook sequence. Babel's plugin signs each component; here
 *     the module's hook calls are signed as a whole (`hookSignature`), and a
 *     change makes the update a full reload rather than a refresh.
 *
 * A module is a refresh BOUNDARY when every export is a registered component:
 * re-running it is all an update needs. Edits to anything else propagate to the
 * modules importing it until they reach boundaries, or the entry (a reload).
 */
export const REFRESH_GLOBAL = '__bfwc_refresh';

/** React with a DOM renderer and the automatic or classic React JSX runtime. */
export function usesReactRefresh(config: ProjectConfig): boolean {
  return 'react-dom' in config.dependencies && config.jsx.importSource === 'react';
}

/**
 * Inline module script, placed before the app's: installs the runtime into React's
 * DevTools hook, which react-dom reads once, when it first loads — so it must
 * run first. Module scripts run in document order, which guarantees that.
 */
export function refreshPreambleScript(runtimeUrl: string): string {
  return [
    `<script type="module">`,
    `import * as runtime from ${JSON.stringify(runtimeUrl)};`,
    `const refresh = runtime.default || runtime;`,
    `refresh.injectIntoGlobalHook(window);`,
    `window.$RefreshReg$ = () => {};`,
    `window.$RefreshSig$ = () => (type) => type;`,
    `window.${REFRESH_GLOBAL} = refresh;`,
    `</script>`,
  ].join('\n');
}

/**
 * Top-level bindings in compiled code that look like components: PascalCase
 * function and class declarations, and PascalCase consts bound to a function,
 * arrow, `memo(…)` or `forwardRef(…)`. Compiled output puts top-level statements
 * at column 0, which keeps this to line-anchored patterns.
 */
export function componentNames(code: string): string[] {
  const names = new Set<string>();
  const declaration = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function\*?|class)\s+([A-Z][\w$]*)/gm;
  const binding = /^(?:export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|[\w$]+\s*=>|(?:[\w$]+\.)?(?:memo|forwardRef)\s*\()/gm;
  for (const match of code.matchAll(declaration)) names.add(match[1]!);
  for (const match of code.matchAll(binding)) names.add(match[1]!);
  return [...names];
}

/** Appended to a module: register each component under `<path> <name>`. */
export function refreshFooter(path: string, names: readonly string[]): string {
  if (!names.length) return '';
  const lines = names.map((name) => `  refresh.register(${name}, ${JSON.stringify(`${path} ${name}`)});`);
  return `\n{ const refresh = window.${REFRESH_GLOBAL};\nif (refresh) {\n${lines.join('\n')}\n} }\n`;
}

/** The module's hook calls in order, hashed. */
export function hookSignature(source: string): string {
  return contentHash((source.match(/\buse[A-Z][\w$]*\s*\(/g) ?? []).map((call) => call.replace(/\s*\($/, '')).join(','));
}

/**
 * What the dev server learns about a compiled module: whether it is a refresh
 * boundary (it exports something, and every export is one of `components`),
 * and its hook signature (from `source`, the code as written).
 */
export async function refreshFacts(code: string, source: string, components: readonly string[]): Promise<ModuleFacts> {
  await init;
  const [, exports] = parse(code);
  const known = new Set(components);
  // The lexer names the local behind most exports; spell out the default forms it may not.
  const defaultExpression =
    /^export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Z][\w$]*)/m.exec(code)?.[1] ?? /^export\s+default\s+([A-Z][\w$]*)\s*;?\s*$/m.exec(code)?.[1];
  const refreshBoundary =
    exports.length > 0 &&
    exports.every((entry) => {
      const local = entry.ln ?? (entry.n === 'default' ? defaultExpression : entry.n);
      return local !== undefined && known.has(local);
    });
  return { refreshBoundary, hooks: hookSignature(source) };
}
