import type { FetchLike, FetchResponseLike } from '@seanhogg/builderforce-webcontainers-core/check';

/**
 * `fetch` for type definitions, backed by Cache Storage so a new tab (or a new
 * worker) does not download lib.dom.d.ts and React's types again.
 *
 * Only immutable URLs are cached: lib files under a pinned TypeScript version and
 * package files at an exact `name@x.y.z`. Range lookups (`react@^18`) always go to
 * the network, so a new release is picked up. A cached entry keeps the final URL
 * and the `X-TypeScript-Types` header, the two things acquisition reads besides
 * the body.
 */
const CACHE_NAME = 'bfwc-types-v1';
const EXACT_VERSION = /@\d+\.\d+\.\d+(?:[-+][\w.]+)?\//;
const FINAL_URL = 'x-bfwc-final-url';
const TYPES = 'x-typescript-types';

interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, response: Response): Promise<void>;
}

function wrap(url: string, body: string, types: string | null): FetchResponseLike {
  return { ok: true, url, headers: { get: (name) => (name.toLowerCase() === TYPES ? types : null) }, text: async () => body };
}

export function createCachedFetch(base: typeof fetch = fetch): FetchLike {
  let cache: Promise<CacheLike | undefined> | undefined;
  const open = () =>
    (cache ??= typeof caches === 'undefined' ? Promise.resolve(undefined) : caches.open(CACHE_NAME).catch(() => undefined));

  return async (url) => {
    const cacheable = EXACT_VERSION.test(url);
    const store = cacheable ? await open() : undefined;
    const hit = await store?.match(url).catch(() => undefined);
    if (hit) return wrap(hit.headers.get(FINAL_URL) ?? url, await hit.text(), hit.headers.get(TYPES));

    const res = await base(url);
    if (!res.ok || !store) return res;
    const body = await res.text();
    const types = res.headers.get(TYPES);
    const headers: Record<string, string> = { [FINAL_URL]: res.url || url };
    if (types) headers[TYPES] = types;
    await store.put(url, new Response(body, { headers })).catch(() => undefined);
    return wrap(res.url || url, body, types);
  };
}
