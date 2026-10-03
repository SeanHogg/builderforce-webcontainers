import {
  createSvelteCompiler,
  createVueCompiler,
  isRegistryRange,
  type ComponentCompiler,
  type ComponentCompilers,
  type SvelteCompilerLike,
  type VueCompilerSfcLike,
} from '@seanhogg/builderforce-webcontainers-core';

/**
 * The Vue and Svelte compilers, fetched from a CDN the first time a project
 * needs one — nothing is downloaded for a React app — and pinned to the
 * project's own framework range, so compiler and runtime agree. (Svelte's
 * compiled output calls internal runtime functions that change between minors;
 * the runtime is served by esm.sh from the same range, so the compiler is too.)
 */
export interface CdnComponentCompilerOptions {
  /** The ES module URL of `@vue/compiler-sfc`'s browser build for a `vue` range. */
  vueCompilerUrl?: (range: string) => string;
  /** The ES module URL of `svelte/compiler` for a `svelte` range. */
  svelteCompilerUrl?: (range: string) => string;
  /** Loads a module by URL. Default: native `import()`. */
  importModule?: (url: string) => Promise<unknown>;
}

/** Self-contained ESM build the official Vue SFC playground loads. */
export const defaultVueCompilerUrl = (range: string) =>
  `https://cdn.jsdelivr.net/npm/@vue/compiler-sfc@${range}/dist/compiler-sfc.esm-browser.js`;

export const defaultSvelteCompilerUrl = (range: string) => `https://esm.sh/svelte@${range}/compiler`;

/**
 * `import()` of a runtime URL. The magic comments stop the host app's bundler
 * (webpack, Vite) from trying to resolve the CDN URL at build time.
 */
const nativeImport = (url: string): Promise<unknown> => import(/* webpackIgnore: true */ /* @vite-ignore */ url);

function rangeOf(dependencies: Readonly<Record<string, string>>, name: string, fallback: string): string {
  const range = dependencies[name];
  return range && isRegistryRange(range) ? range : fallback;
}

export function createCdnComponentCompilers(options: CdnComponentCompilerOptions = {}): ComponentCompilers {
  const load = options.importModule ?? nativeImport;
  const cache = new Map<string, Promise<ComponentCompiler>>();

  const memo = (url: string, make: (module: unknown) => ComponentCompiler): Promise<ComponentCompiler> => {
    let hit = cache.get(url);
    if (!hit) {
      hit = load(url).then(make);
      hit.catch(() => cache.delete(url)); // a failed download may be retried
      cache.set(url, hit);
    }
    return hit;
  };

  return (extension, dependencies) => {
    if (extension === '.vue') {
      const url = (options.vueCompilerUrl ?? defaultVueCompilerUrl)(rangeOf(dependencies, 'vue', '3'));
      return memo(url, (module) => createVueCompiler(module as VueCompilerSfcLike));
    }
    const url = (options.svelteCompilerUrl ?? defaultSvelteCompilerUrl)(rangeOf(dependencies, 'svelte', '5'));
    return memo(url, (module) => createSvelteCompiler(module as SvelteCompilerLike));
  };
}
