import type { VirtualFileSystem } from './vfs.js';
import type { TypeScriptOptions } from './transformer.js';
import { join, normalizePath } from './paths.js';
import { applyPinGroups } from './pinGroups.js';

/**
 * What the dev server needs to know about a project, read from its own files:
 * dependency versions (for the package CDN), tsconfig path aliases and JSX mode,
 * and `VITE_*` variables from `.env` files.
 *
 * Everything here is derived, so it is recomputed whenever one of
 * {@link CONFIG_FILES} changes and is otherwise read from the cache.
 */
export const CONFIG_FILES = [
  '/package.json',
  '/tsconfig.json',
  '/jsconfig.json',
  '/.env',
  '/.env.local',
  '/.env.development',
  '/.env.development.local',
  '/.env.production',
  '/.env.production.local',
  '/angular.json',
] as const;

/** Which `.env.<mode>` files apply: the dev server reads development, a build production. */
export type BuildMode = 'development' | 'production';

/** Vite's load order — later files win. */
export function envFiles(mode: BuildMode): string[] {
  return ['/.env', '/.env.local', `/.env.${mode}`, `/.env.${mode}.local`];
}

export interface PathAlias {
  /** The specifier prefix, without the trailing `*` (`@/`). Exact when `wildcard` is false. */
  prefix: string;
  wildcard: boolean;
  /** Absolute VFS targets, without the trailing `*`, tried in order. */
  targets: string[];
}

export interface ProjectConfig {
  /**
   * dependencies + devDependencies, name → version range, with the framework pin
   * groups applied (see {@link applyPinGroups}): the one set the package CDN and
   * the component compilers see.
   */
  dependencies: Record<string, string>;
  /**
   * The tsconfig compiler options that change emitted code. `target` is applied
   * only at or above this runtime's floors (see `targetAtLeast` in transformer.ts).
   */
  typescript: TypeScriptOptions;
  aliases: PathAlias[];
  /** Bare package names served as another package (`react-native` → `react-native-web`). */
  packageAliases: Record<string, string>;
  jsx: { runtime: 'automatic' | 'classic'; importSource: string };
  /** `VITE_*` and `NODE_ENV` style variables from the `.env` files, in load order. */
  env: Record<string, string>;
}

/** JSON that tolerates the comments and trailing commas tsconfig files carry. */
export function parseLooseJson(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; }
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readJson(fs: VirtualFileSystem, path: string): Record<string, unknown> | undefined {
  const text = fs.readText(path);
  if (text === undefined) return undefined;
  try {
    const value = parseLooseJson(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** package.json dependencies + devDependencies, name → range (comments tolerated; `{}` when unreadable). */
export function readDependencies(fs: VirtualFileSystem): Record<string, string> {
  const pkg = readJson(fs, '/package.json') ?? {};
  const out: Record<string, string> = {};
  for (const field of ['devDependencies', 'dependencies']) {
    for (const [name, version] of Object.entries(asRecord(pkg[field]))) {
      if (typeof version === 'string') out[name] = version;
    }
  }
  return out;
}

/**
 * The root tsconfig's compiler options. Current Vite templates (React, Vue,
 * Svelte) keep a root `tsconfig.json` with only `references`, and the app's real
 * options — `paths` included — in `tsconfig.app.json`; options missing from the
 * root are taken from the referenced configs, in order.
 */
function readCompilerOptions(fs: VirtualFileSystem): Record<string, unknown> {
  const tsconfig = readJson(fs, '/tsconfig.json') ?? readJson(fs, '/jsconfig.json') ?? {};
  const options = { ...asRecord(tsconfig.compilerOptions) };
  const references = Array.isArray(tsconfig.references) ? tsconfig.references : [];
  for (const reference of references) {
    const target = asRecord(reference).path;
    if (typeof target !== 'string') continue;
    const file = target.endsWith('.json') ? join('/', target) : join('/', target, 'tsconfig.json');
    for (const [key, value] of Object.entries(asRecord(readJson(fs, file)?.compilerOptions))) {
      if (!(key in options)) options[key] = value;
    }
  }
  return options;
}

function readAliases(options: Record<string, unknown>): PathAlias[] {
  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : '.';
  const aliases: PathAlias[] = [];
  for (const [pattern, rawTargets] of Object.entries(asRecord(options.paths))) {
    if (!Array.isArray(rawTargets)) continue;
    const wildcard = pattern.endsWith('*');
    const targets = rawTargets
      .filter((t): t is string => typeof t === 'string')
      .map((t) => {
        const stripped = wildcard ? t.replace(/\*$/, '') : t;
        const resolved = join('/', baseUrl, stripped);
        return stripped.endsWith('/') && resolved !== '/' ? resolved + '/' : resolved;
      });
    aliases.push({ prefix: wildcard ? pattern.slice(0, -1) : pattern, wildcard, targets });
  }
  // Longest prefix first, so `@/components/*` wins over `@/*`.
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Packages a project serves as their browser twin. A React Native Web app aliases
 * `react-native` to `react-native-web` in its Vite or webpack config, which this
 * runtime does not execute; depending on the twin is the same signal, read from
 * package.json. Without it the app imports the real `react-native`, which does not
 * load in a browser. Data, not branches: another twin is another row.
 */
const BROWSER_TWINS: ReadonlyArray<{ name: string; twin: string }> = [
  { name: 'react-native', twin: 'react-native-web' },
];

function readPackageAliases(dependencies: Record<string, string>): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const { name, twin } of BROWSER_TWINS) if (twin in dependencies) aliases[name] = twin;
  return aliases;
}

function readJsx(options: Record<string, unknown>): ProjectConfig['jsx'] {
  const importSource = typeof options.jsxImportSource === 'string' ? options.jsxImportSource : 'react';
  const runtime = options.jsx === 'react' ? 'classic' : 'automatic';
  return { runtime, importSource };
}

/** A `.env` assignment's head: optional `export `, the key, `=` (spaces around it allowed). */
const DOTENV_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*=[ \t]*/;
/** Escapes a double-quoted `.env` value reads (`\n`, `\r`, `\t`, `\"`, `\\`, `\$`); any other backslash is kept as written. */
const DOTENV_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', $: '$' };

/** The index of the quote closing a value opened at `from - 1`: a single-quoted value has no escapes, a double-quoted one skips `\x`. */
function closingQuote(text: string, from: number, quote: string): number {
  if (quote === "'") return text.indexOf("'", from);
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/**
 * A `.env` file's `KEY=value` assignments, read as dotenv and phpdotenv read them:
 * - blank lines, `#` comment lines and lines that are not an assignment are skipped; `export ` is dropped;
 * - a quoted value runs to its closing quote (it may span lines, and holds the other
 *   quote and `#` as text); anything after the closing quote is ignored. A single-quoted
 *   value is literal; a double-quoted one reads `\n`, `\r`, `\t`, `\"`, `\\` and `\$`;
 * - an unquoted value ends at a `#` that starts it or follows whitespace (an inline
 *   comment: `a#b` keeps its `#`), and is trimmed. A value whose quote never closes is unquoted;
 * - no `${…}` expansion; a later assignment of a key wins.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const source = text.replace(/\r\n?/g, '\n');
  const endOfLine = (from: number) => {
    const end = source.indexOf('\n', from);
    return end < 0 ? source.length : end;
  };
  let at = 0;
  while (at < source.length) {
    const lineEnd = endOfLine(at);
    const head = DOTENV_ASSIGNMENT.exec(source.slice(at, lineEnd));
    if (!head) {
      at = lineEnd + 1;
      continue;
    }
    const key = head[1]!;
    const start = at + head[0].length;
    const quote = source[start];
    if (quote === '"' || quote === "'") {
      const close = closingQuote(source, start + 1, quote);
      if (close >= 0) {
        const body = source.slice(start + 1, close);
        out[key] = quote === "'" ? body : body.replace(/\\(.)/gs, (escape, char: string) => DOTENV_ESCAPES[char] ?? escape);
        at = endOfLine(close) + 1;
        continue;
      }
    }
    const raw = source.slice(start, lineEnd);
    out[key] = raw.startsWith('#') ? '' : raw.replace(/[ \t]+#.*$/, '').trim();
    at = lineEnd + 1;
  }
  return out;
}

function readEnv(fs: VirtualFileSystem, mode: BuildMode): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of envFiles(mode)) {
    const text = fs.readText(file);
    if (text !== undefined) Object.assign(env, parseDotenv(text));
  }
  return env;
}

/** tsconfig `target` → an esbuild target. ES3/ES5 are below what esbuild can lower to, so they become es2015. */
function esbuildTarget(target: unknown): string | undefined {
  if (typeof target !== 'string') return undefined;
  const lower = target.toLowerCase();
  if (lower === 'es3' || lower === 'es5') return 'es2015';
  if (lower === 'es6') return 'es2015';
  return /^es(next|20\d\d)$/.test(lower) ? lower : undefined;
}

function readTypeScript(options: Record<string, unknown>): TypeScriptOptions {
  const out: TypeScriptOptions = {};
  if (typeof options.experimentalDecorators === 'boolean') out.experimentalDecorators = options.experimentalDecorators;
  if (typeof options.useDefineForClassFields === 'boolean') out.useDefineForClassFields = options.useDefineForClassFields;
  const target = esbuildTarget(options.target);
  if (target) out.target = target;
  return out;
}

export function readProjectConfig(fs: VirtualFileSystem, mode: BuildMode = 'development'): ProjectConfig {
  const options = readCompilerOptions(fs);
  const dependencies = applyPinGroups(readDependencies(fs));
  return {
    dependencies,
    typescript: readTypeScript(options),
    aliases: readAliases(options),
    packageAliases: readPackageAliases(dependencies),
    jsx: readJsx(options),
    env: readEnv(fs, mode),
  };
}

/** True when a change to `path` invalidates the derived {@link ProjectConfig}. */
export function isConfigFile(path: string): boolean {
  const normalized = normalizePath(path);
  // Any root tsconfig: the root one may reference `tsconfig.app.json` and friends.
  return (CONFIG_FILES as readonly string[]).includes(normalized) || /^\/tsconfig[^/]*\.json$/.test(normalized);
}
