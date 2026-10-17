import { isRegistryRange } from '@seanhogg/builderforce-webcontainers-core';

/**
 * Loading a compiler (Vue, Svelte, Sass, Less) from a CDN the first time a
 * project needs it — nothing is downloaded for a project that doesn't — pinned
 * to the project's own range, so compiler and runtime agree.
 */
export type ImportModule = (url: string) => Promise<unknown>;

/**
 * `import()` of a runtime URL. The magic comments stop the host app's bundler
 * (webpack, Vite) from trying to resolve the CDN URL at build time.
 */
export const nativeImport: ImportModule = (url) => import(/* webpackIgnore: true */ /* @vite-ignore */ url);

/** The project's range for `name` when the CDN can fetch it, else `fallback`. */
export function rangeOf(dependencies: Readonly<Record<string, string>>, name: string, fallback: string): string {
  const range = dependencies[name];
  return range && isRegistryRange(range) ? range : fallback;
}

/** One load per URL; a failed download is forgotten so the next request retries. */
export function memoizedLoader<T>(load: ImportModule): (url: string, make: (module: unknown) => T) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (url, make) => {
    let hit = cache.get(url);
    if (!hit) {
      hit = load(url).then(make);
      hit.catch(() => cache.delete(url));
      cache.set(url, hit);
    }
    return hit;
  };
}
