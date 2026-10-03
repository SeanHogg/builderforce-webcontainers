import type * as TS from 'typescript';
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, extname, join } from '../paths.js';
import type { TypeStore } from './typeStore.js';

/**
 * Which programs to build, with which options, over which files — what `tsc -b`
 * would derive from the project's tsconfig files.
 *
 * Vite's templates keep a root `tsconfig.json` holding only `references` (to
 * `tsconfig.app.json` and `tsconfig.node.json`); each reference is its own
 * program. With no tsconfig at all, the checker synthesises Vite's defaults for
 * a React + TS app, so a generated project with no config still gets checked.
 */
export interface CheckProject {
  /** The tsconfig this came from; undefined when synthesised. */
  configPath?: string;
  options: TS.CompilerOptions;
  rootNames: string[];
  /** Problems parsing the config itself. */
  errors: readonly TS.Diagnostic[];
}

/** Tool configs (`vite.config.ts`…) describe the build, which runs elsewhere: not checked. */
const TOOL_CONFIG = /(^|\/)(vite|vitest|svelte|tailwind|postcss|eslint|prettier|playwright)\.config\.[cm]?[jt]s$/;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
/** "No inputs were found in config file" — a reference covering only tool configs. */
const NO_INPUTS = 18003;

/** Vite's React + TS template, made strict-ish; what a project with no tsconfig gets. */
export function defaultCompilerOptions(ts: typeof TS, jsxImportSource?: string): TS.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2020,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    ...(jsxImportSource ? { jsxImportSource } : {}),
    strict: true,
    noFallthroughCasesInSwitch: true,
    isolatedModules: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  };
}

/** Options no in-browser check wants, whatever the config says: nothing is emitted. */
function forCheck(options: TS.CompilerOptions): TS.CompilerOptions {
  return {
    ...options,
    noEmit: true,
    skipLibCheck: true,
    composite: false,
    incremental: false,
    declaration: false,
    declarationMap: false,
    emitDeclarationOnly: false,
    tsBuildInfoFile: undefined,
  };
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*' && pattern[i + 2] === '/') {
      source += '(?:[^/]+/)*';
      i += 2;
    } else if (ch === '*') source += '[^/]*';
    else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** A tsconfig `include`/`exclude` spec as a matcher; a bare directory means everything under it. */
function specMatcher(root: string, spec: string): RegExp {
  let abs = join(root, spec);
  const last = abs.slice(abs.lastIndexOf('/') + 1);
  if (!/[*?]/.test(last) && !extname(last)) abs = `${abs === '/' ? '' : abs}/**/*`;
  return globToRegExp(abs);
}

/** The ParseConfigHost the config parser reads through: the VFS plus fetched `extends` packages. */
export function createParseConfigHost(fs: VirtualFileSystem, store: TypeStore): TS.ParseConfigHost {
  return {
    useCaseSensitiveFileNames: true,
    fileExists: (path) => fs.isFile(path) || store.read(path) !== undefined,
    readFile: (path) => fs.readText(path) ?? store.read(path),
    readDirectory(rootDir, extensions, excludes, includes) {
      const include = (includes ?? ['**/*']).map((spec) => specMatcher(rootDir, spec));
      const exclude = (excludes ?? []).map((spec) => specMatcher(rootDir, spec));
      return fs.list().filter((path) =>
        extensions.some((ext) => path.endsWith(ext)) &&
        !path.includes('/node_modules/') &&
        include.some((re) => re.test(path)) &&
        !exclude.some((re) => re.test(path)),
      );
    },
  };
}

function parseConfig(ts: typeof TS, host: TS.ParseConfigHost, configPath: string): TS.ParsedCommandLine | { errors: TS.Diagnostic[] } {
  const text = host.readFile(configPath) ?? '';
  const json = ts.parseConfigFileTextToJson(configPath, text);
  if (json.error) return { errors: [json.error] };
  return ts.parseJsonConfigFileContent(json.config, host, dirname(configPath), undefined, configPath);
}

function referencedConfigs(ts: typeof TS, host: TS.ParseConfigHost, configPath: string): string[] {
  const json = ts.parseConfigFileTextToJson(configPath, host.readFile(configPath) ?? '').config as { references?: Array<{ path?: unknown }>; files?: unknown[]; include?: unknown[] } | undefined;
  const references = json?.references ?? [];
  // A "solution" config — references and nothing of its own — is checked through its references.
  const ownsFiles = (json?.files?.length ?? 0) > 0 || json?.include !== undefined;
  if (!references.length || ownsFiles) return [];
  return references
    .map((ref) => (typeof ref.path === 'string' ? join(dirname(configPath), ref.path) : undefined))
    .filter((path): path is string => !!path)
    .map((path) => (path.endsWith('.json') ? path : join(path, 'tsconfig.json')))
    .filter((path) => host.fileExists(path));
}

export function resolveCheckProjects(ts: typeof TS, fs: VirtualFileSystem, store: TypeStore, jsxImportSource?: string): CheckProject[] {
  const host = createParseConfigHost(fs, store);
  const root = ['/tsconfig.json', '/jsconfig.json'].find((path) => fs.isFile(path));

  if (!root) {
    const rootNames = fs.list().filter((path) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) && !path.includes('/node_modules/') && !TOOL_CONFIG.test(path));
    return rootNames.length ? [{ options: defaultCompilerOptions(ts, jsxImportSource), rootNames, errors: [] }] : [];
  }

  const configs = referencedConfigs(ts, host, root);
  const projects: CheckProject[] = [];
  for (const configPath of configs.length ? configs : [root]) {
    const parsed = parseConfig(ts, host, configPath);
    const errors = parsed.errors.filter((d) => d.code !== NO_INPUTS);
    if (!('options' in parsed)) {
      projects.push({ configPath, options: {}, rootNames: [], errors });
      continue;
    }
    const rootNames = parsed.fileNames.filter((path) => !TOOL_CONFIG.test(path));
    if (!rootNames.length && !errors.length) continue;
    projects.push({ configPath, options: forCheck(parsed.options), rootNames, errors });
  }
  return projects;
}
