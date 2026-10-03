import type { Loader } from './transformer.js';

/**
 * Single-file components (`.vue`, `.svelte`) as a PORT, like the Transformer. A
 * component compiler turns one file into a script module plus the CSS it owns;
 * the dev server injects that CSS with a <style> tag and the build extracts it
 * into the CSS bundle, so the compilers themselves never touch the DOM.
 *
 * The core never imports a framework compiler. The browser runtime loads the
 * official ones from a CDN on first use, pinned to the project's own framework
 * version (a Svelte compiler must match its runtime exactly); Node tests pass the
 * npm packages in.
 */
export type ComponentExtension = '.vue' | '.svelte';

export const COMPONENT_EXTENSIONS: readonly ComponentExtension[] = ['.vue', '.svelte'];

export function componentExtension(ext: string): ComponentExtension | undefined {
  return (COMPONENT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as ComponentExtension) : undefined;
}

export interface ComponentRequest {
  /** The VFS path — names the component in errors and seeds its style scope id. */
  path: string;
  /** Development output (dev warnings, readable names) vs production. */
  dev: boolean;
}

export interface CompiledComponent {
  /** An ES module (still TS when `loader` says so) whose default export is the component. */
  code: string;
  loader: Loader;
  /** The component's styles, already scoped. Empty when it has none. */
  css: string;
}

export interface ComponentCompiler {
  compile(source: string, request: ComponentRequest): Promise<CompiledComponent> | CompiledComponent;
}

/**
 * Supplies the compiler for an extension. Given the project's dependency ranges
 * so a loader can fetch the compiler version that matches the project's runtime.
 */
export type ComponentCompilers = (
  extension: ComponentExtension,
  dependencies: Readonly<Record<string, string>>,
) => Promise<ComponentCompiler>;

/** Compilers already in hand (tests, a host that bundles them), keyed by extension. */
export function staticComponentCompilers(compilers: Partial<Record<ComponentExtension, ComponentCompiler>>): ComponentCompilers {
  return (extension) => {
    const compiler = compilers[extension];
    return compiler ? Promise.resolve(compiler) : Promise.reject(new Error(`No compiler for ${extension} files is configured.`));
  };
}

/** The default when a host configures none: a clear error instead of serving source. */
export const noComponentCompilers: ComponentCompilers = staticComponentCompilers({});
