import type { PackageCache } from '@seanhogg/builderforce-webcontainers-core';

/**
 * The installer's cache backed by Cache Storage, so a second `npm install` (or a
 * reload) reuses tarballs instead of downloading them again. Cache Storage keys
 * must be http(s) requests, so each key is folded into a URL on a reserved
 * `.invalid` host that can never be fetched for real.
 *
 * Falls back to a no-op cache where Cache Storage is unavailable (an insecure
 * context, or a browser that blocks it in private mode).
 */
export function createCacheStoragePackageCache(name = 'bfwc-packages'): PackageCache {
  const storage = (globalThis as { caches?: CacheStorage }).caches;
  if (!storage) return { get: async () => undefined, put: async () => undefined };
  let opened: Promise<Cache | undefined> | undefined;
  const open = () => (opened ??= storage.open(name).catch(() => undefined));
  const keyUrl = (key: string) => `https://bfwc-cache.invalid/${encodeURIComponent(key)}`;
  return {
    async get(key) {
      const response = await (await open())?.match(keyUrl(key)).catch(() => undefined);
      return response ? new Uint8Array(await response.arrayBuffer()) : undefined;
    },
    async put(key, data) {
      const body = data.slice().buffer as ArrayBuffer;
      await (await open())?.put(keyUrl(key), new Response(body)).catch(() => undefined); // quota errors just skip caching
    },
  };
}
