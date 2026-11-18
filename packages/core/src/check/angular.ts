/**
 * Angular-aware pre-run diagnostics: constructs the Angular CLI accepts (or that
 * only its Node builders handle) but this runtime cannot run, flagged by the
 * check instead of surfacing as a white page. Plain text scanning — no Angular
 * compiler — and only for projects that depend on `@angular/core`.
 *
 *   BFWC-NG001  error    arrow function in a template expression
 *   BFWC-NG002  error    `@angular/ssr` / `@angular/platform-server` imported by browser code
 *   BFWC-NG003  warning  an angular.json target whose builder this runtime does not replace
 *   BFWC-NG004  warning  SSR / prerender / app-shell build options (ignored here)
 *   BFWC-NG005  warning  `localize` / i18n configuration (ignored here)
 */
import type { VirtualFileSystem } from '../vfs.js';
import { templateArrowOffsets } from './angularTemplates.js';
import { lineColumn, type CheckDiagnostic, type DiagnosticCategory } from './diagnostics.js';
import { maskCode, skipString } from '../angular/scanner.js';
import { stringLiteralValue } from '../angular/syntax.js';
import { resolveResourcePath } from '../componentResources.js';
import { parseLooseJson, readDependencies } from '../projectConfig.js';

export const ANGULAR_DIAGNOSTIC = {
  templateArrow: 1,
  serverImport: 2,
  unsupportedBuilder: 3,
  serverBuildOption: 4,
  localize: 5,
} as const;

/** Builders whose job (build and serve the app) this runtime does itself. */
const REPLACED_BUILDERS = new Set([
  '@angular-devkit/build-angular:application',
  '@angular-devkit/build-angular:browser',
  '@angular-devkit/build-angular:browser-esbuild',
  '@angular-devkit/build-angular:dev-server',
  '@angular/build:application',
  '@angular/build:dev-server',
]);
/**
 * Tool targets every `ng new` scaffolds (`ng test`, `ng extract-i18n`): they do not
 * build or serve the app, so not running them here is not worth a warning on
 * every Angular project.
 */
const TOOL_BUILDER = /^(?:@angular\/build|@angular-devkit\/build-angular):(?:extract-i18n|karma|unit-test|jest|web-test-runner)$/;

const SCRIPT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IGNORED_DIR = /(^|\/)(?:node_modules|dist|\.angular)\//;
/** Server-only entry points an `ng new --ssr` app has; they are meant to import the SSR packages. */
const SERVER_FILE = /(?:^|\/)server\.[mc]?[jt]s$|\.server\.[mc]?[jt]s$/;
/**
 * The patterns below run over MASKED code (angular/scanner.ts): comments,
 * regexes and string contents are blank, a literal's quotes are kept — so each
 * finds where a literal starts, and the literal is then read from the source.
 */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(?=["'])/g;
const SERVER_PACKAGE = /^@angular\/(?:ssr|platform-server)(?:\/|$)/;
const INLINE_TEMPLATE = /\btemplate\s*:\s*(?=["'`])/g;
const TEMPLATE_URL = /\btemplateUrl\s*:\s*(?=["'`])/g;

/** The value of the string literal starting at `start`, and where it ends. */
function literalAt(text: string, start: number): { value: string | undefined; end: number } {
  const end = skipString(text, start);
  return { value: stringLiteralValue(text.slice(start, end)), end };
}

const SERVER_OPTIONS: Record<string, string> = {
  ssr: 'server-side rendering',
  server: 'a server bundle',
  prerender: 'prerendering',
  appShell: 'an app shell',
};

interface Json {
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function diagnostic(path: string, text: string, offset: number, code: number, category: DiagnosticCategory, message: string): CheckDiagnostic {
  return { file: path.slice(1), ...lineColumn(text, offset), message, code, category, source: 'angular' };
}

const ARROW_MESSAGE =
  'Arrow functions are not supported in Angular template expressions. Move the function into the component class and call it from the template.';

function templateDiagnostics(fs: VirtualFileSystem, sources: string[]): CheckDiagnostic[] {
  const out: CheckDiagnostic[] = [];
  const templateFiles = new Set<string>();
  for (const path of sources) {
    if (!/\.[mc]?ts$/.test(path) || path.endsWith('.d.ts')) continue;
    const text = fs.readText(path) ?? '';
    const code = maskCode(text);
    for (const match of code.matchAll(INLINE_TEMPLATE)) {
      const start = match.index + match[0].length;
      const end = skipString(text, start);
      const template = text.slice(start + 1, end - 1);
      for (const offset of templateArrowOffsets(template)) {
        out.push(diagnostic(path, text, start + 1 + offset, ANGULAR_DIAGNOSTIC.templateArrow, 'error', ARROW_MESSAGE));
      }
    }
    for (const match of code.matchAll(TEMPLATE_URL)) {
      const { value: url } = literalAt(text, match.index + match[0].length);
      if (url) templateFiles.add(resolveResourcePath(path, url));
    }
  }
  for (const path of templateFiles) {
    const text = fs.readText(path);
    if (text === undefined) continue;
    for (const offset of templateArrowOffsets(text)) {
      out.push(diagnostic(path, text, offset, ANGULAR_DIAGNOSTIC.templateArrow, 'error', ARROW_MESSAGE));
    }
  }
  return out;
}

function serverImportDiagnostics(fs: VirtualFileSystem, sources: string[]): CheckDiagnostic[] {
  const out: CheckDiagnostic[] = [];
  for (const path of sources) {
    if (SERVER_FILE.test(path)) continue;
    const text = fs.readText(path) ?? '';
    for (const match of maskCode(text).matchAll(SPECIFIER)) {
      const quote = match.index + match[0].length;
      const specifier = literalAt(text, quote).value;
      if (specifier === undefined || !SERVER_PACKAGE.test(specifier)) continue;
      const offset = quote + 1;
      out.push(
        diagnostic(
          path,
          text,
          offset,
          ANGULAR_DIAGNOSTIC.serverImport,
          'error',
          `'${specifier}' is server-side rendering code and does not run in the browser preview. Keep it in server-only files (server.ts, *.server.ts).`,
        ),
      );
    }
  }
  return out;
}

/** The offset of `needles` found one after another in `text` (the last one's position), or 0. */
function locate(text: string, ...needles: string[]): number {
  let at = 0;
  for (const needle of needles) {
    const found = text.indexOf(needle, at);
    if (found === -1) return at;
    at = found;
  }
  return at;
}

function angularJsonDiagnostics(fs: VirtualFileSystem): CheckDiagnostic[] {
  const path = '/angular.json';
  const text = fs.readText(path);
  if (text === undefined) return [];
  let config: Json;
  try {
    // angular.json may carry comments and trailing commas, as tsconfig files do.
    const parsed = parseLooseJson(text);
    if (!isObject(parsed)) return [];
    config = parsed;
  } catch {
    return [];
  }
  const out: CheckDiagnostic[] = [];
  const at = (category: DiagnosticCategory, code: number, message: string, ...needles: string[]) =>
    out.push(diagnostic(path, text, locate(text, ...needles), code, category, message));

  for (const [name, project] of Object.entries(isObject(config.projects) ? config.projects : {})) {
    if (!isObject(project)) continue;
    const key = JSON.stringify(name);
    if (project.i18n !== undefined) {
      at('warning', ANGULAR_DIAGNOSTIC.localize, `Project ${key} configures i18n; localized builds are not produced here, the preview serves the source locale.`, key, '"i18n"');
    }
    const targets = isObject(project.architect) ? project.architect : isObject(project.targets) ? project.targets : {};
    for (const [target, definition] of Object.entries(targets)) {
      if (!isObject(definition) || typeof definition.builder !== 'string') continue;
      const builder = definition.builder;
      const targetKey = JSON.stringify(target);
      if (!REPLACED_BUILDERS.has(builder)) {
        if (!TOOL_BUILDER.test(builder)) {
          at('warning', ANGULAR_DIAGNOSTIC.unsupportedBuilder, `\`ng ${target}\` uses the builder '${builder}', which does not run here; only the app build and dev server are replaced.`, key, targetKey, '"builder"');
        }
        continue;
      }
      const optionSets = [definition.options, ...(isObject(definition.configurations) ? Object.values(definition.configurations) : [])].filter(isObject);
      const reported = new Set<string>();
      for (const options of optionSets) {
        for (const [option, what] of Object.entries(SERVER_OPTIONS)) {
          if (!options[option] || reported.has(option)) continue;
          reported.add(option);
          at('warning', ANGULAR_DIAGNOSTIC.serverBuildOption, `\`${option}\` in ${target} is ignored: ${what} does not run here, the preview is a client-side app.`, key, targetKey, JSON.stringify(option));
        }
        if (options.outputMode === 'server' && !reported.has('outputMode')) {
          reported.add('outputMode');
          at('warning', ANGULAR_DIAGNOSTIC.serverBuildOption, `\`outputMode: "server"\` in ${target} is ignored: there is no server here, the preview is a client-side app.`, key, targetKey, '"outputMode"');
        }
        if (options.localize && !reported.has('localize')) {
          reported.add('localize');
          at('warning', ANGULAR_DIAGNOSTIC.localize, `\`localize\` in ${target} is ignored: localized builds are not produced here, the preview serves the source locale.`, key, targetKey, '"localize"');
        }
      }
    }
  }
  return out;
}

/** Angular constructs this runtime cannot run, as check diagnostics. Empty unless the project depends on `@angular/core`. */
export function angularDiagnostics(fs: VirtualFileSystem): CheckDiagnostic[] {
  if (!Object.hasOwn(readDependencies(fs), '@angular/core')) return [];
  const sources = fs.list().filter((path) => SCRIPT.test(path) && !IGNORED_DIR.test(path));
  return [...templateDiagnostics(fs, sources), ...serverImportDiagnostics(fs, sources), ...angularJsonDiagnostics(fs)];
}
