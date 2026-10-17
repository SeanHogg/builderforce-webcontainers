import {
  createSvelteCompiler,
  createVueCompiler,
  type ComponentCompiler,
  type ComponentCompilers,
  type SvelteCompilerLike,
  type VueCompilerSfcLike,
} from '@seanhogg/builderforce-webcontainers-core';
import { memoizedLoader, nativeImport, rangeOf, type ImportModule } from './cdnModules.js';

/**
 * The Vue and Svelte compilers, fetched from a CDN the first time a project
 * needs one, pinned to the project's own framework range. (Svelte's compiled
 * output calls internal runtime functions that change between minors; the
 * runtime is served by esm.sh from the same range, so the compiler is too.)
 */
export interface CdnComponentCompilerOptions {
  /** The ES module URL of `@vue/compiler-sfc`'s browser build for a `vue` range. */
  vueCompilerUrl?: (range: string) => string;
  /** The ES module URL of `svelte/compiler` for a `svelte` range. */
  svelteCompilerUrl?: (range: string) => string;
  /** Loads a module by URL. Default: native `import()`. */
  importModule?: ImportModule;
}

/** Self-contained ESM build the official Vue SFC playground loads. */
export const defaultVueCompilerUrl = (range: string) =>
  `https://cdn.jsdelivr.net/npm/@vue/compiler-sfc@${range}/dist/compiler-sfc.esm-browser.js`;

export const defaultSvelteCompilerUrl = (range: string) => `https://esm.sh/svelte@${range}/compiler`;

export function createCdnComponentCompilers(options: CdnComponentCompilerOptions = {}): ComponentCompilers {
  const load = memoizedLoader<ComponentCompiler>(options.importModule ?? nativeImport);
  return (extension, dependencies) => {
    if (extension === '.vue') {
      const url = (options.vueCompilerUrl ?? defaultVueCompilerUrl)(rangeOf(dependencies, 'vue', '3'));
      return load(url, (module) => createVueCompiler(module as VueCompilerSfcLike));
    }
    const url = (options.svelteCompilerUrl ?? defaultSvelteCompilerUrl)(rangeOf(dependencies, 'svelte', '5'));
    return load(url, (module) => createSvelteCompiler(module as SvelteCompilerLike));
  };
}
