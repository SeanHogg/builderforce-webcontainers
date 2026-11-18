import type { Loader, TypeScriptOptions } from './transformer.js';
import { extname } from './paths.js';

/**
 * Framework source files as a PORT, like the Transformer. A component compiler
 * turns one file into a script module plus the CSS it owns; the dev server
 * injects that CSS with a <style> tag and the build extracts it into the CSS
 * bundle, so the compilers themselves never touch the DOM.
 *
 * Which compiler a file needs is a {@link ComponentKind}: Vue and Svelte by their
 * single-file extensions, Angular for the TypeScript of a project that depends on
 * `@angular/core` (see {@link componentKindFor}).
 *
 * The core never imports a framework compiler it cannot implement itself. The
 * browser runtime loads the official ones from a CDN on first use, pinned to the
 * project's own framework version (a Svelte compiler must match its runtime
 * exactly); Node tests pass the npm packages in.
 */
export type ComponentExtension = '.vue' | '.svelte';

export type ComponentKind = ComponentExtension | 'angular';

/**
 * Which files each kind compiles. Data, not branches: another framework is
 * another row. A row with `dependency` applies only to projects declaring it;
 * `exclude` keeps declaration files and installed packages out.
 */
const COMPONENT_KINDS: ReadonlyArray<{ kind: ComponentKind; extensions: readonly string[]; dependency?: string; exclude?: RegExp }> = [
  { kind: '.vue', extensions: ['.vue'] },
  { kind: '.svelte', extensions: ['.svelte'] },
  { kind: 'angular', extensions: ['.ts', '.mts'], dependency: '@angular/core', exclude: /\.d\.[mc]?ts$|\/node_modules\// },
];

/** The compiler a file needs, or undefined for a file served as plain TS/JS (or not a script at all). */
export function componentKindFor(path: string, dependencies: Readonly<Record<string, string>>): ComponentKind | undefined {
  const ext = extname(path);
  return COMPONENT_KINDS.find((row) =>
    row.extensions.includes(ext) &&
    (!row.dependency || Object.hasOwn(dependencies, row.dependency)) &&
    !row.exclude?.test(path),
  )?.kind;
}

export interface ComponentRequest {
  /** The VFS path — names the component in errors and seeds its style scope id. */
  path: string;
  /** Development output (dev warnings, readable names) vs production. */
  dev: boolean;
  /**
   * Compiles a `<style lang="scss|sass|less">` block to CSS (its imports resolve
   * beside the component). Without it, such a block is an error.
   */
  preprocessStyle?: (lang: string, source: string) => Promise<string>;
  /**
   * Reads a file the component references (an Angular `templateUrl`), resolved
   * against the component's directory; undefined when it does not exist. The
   * module is rebuilt when the file changes.
   */
  readResource?: (relativeOrAbsolutePath: string) => string | undefined;
  /**
   * Compiles a stylesheet file the component references (`.css`, `.scss`, `.sass`,
   * `.less`; resolved like {@link readResource}) to CSS, with the project's own
   * stylesheet compilers.
   */
  compileStylesheet?: (relativeOrAbsolutePath: string) => Promise<string>;
}

export interface CompiledComponent {
  /** An ES module (still TS when `loader` says so) whose default export is the component. */
  code: string;
  loader: Loader;
  /** The component's styles, already scoped. Empty when it has none. */
  css: string;
  /** TypeScript options this module needs, over the project's own (Angular: legacy decorators). */
  typescript?: TypeScriptOptions;
}

export interface ComponentCompiler {
  compile(source: string, request: ComponentRequest): Promise<CompiledComponent> | CompiledComponent;
}

/**
 * Supplies the compiler for a kind. Given the project's dependency ranges so a
 * loader can fetch the compiler version that matches the project's runtime.
 */
export type ComponentCompilers = (
  kind: ComponentKind,
  dependencies: Readonly<Record<string, string>>,
) => Promise<ComponentCompiler>;

/** Compilers already in hand (tests, a host that bundles them), keyed by kind. */
export function staticComponentCompilers(compilers: Partial<Record<ComponentKind, ComponentCompiler>>): ComponentCompilers {
  return (kind) => {
    const compiler = compilers[kind];
    return compiler ? Promise.resolve(compiler) : Promise.reject(new Error(`No compiler for ${kind === 'angular' ? 'Angular' : kind} files is configured.`));
  };
}

/** The default when a host configures none: a clear error instead of serving source. */
export const noComponentCompilers: ComponentCompilers = staticComponentCompilers({});
