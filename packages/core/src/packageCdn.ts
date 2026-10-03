/**
 * Where a bare import (`react`, `react-dom/client`) is fetched from. A PORT, so a
 * fork can point at a self-hosted mirror or an offline cache without touching the
 * rest of the runtime. The default speaks esm.sh's URL scheme.
 */
export interface PackageCdn {
  /** The ES-module URL for `name` + `subpath` (`'' | '/client'`). */
  urlFor(name: string, subpath: string): string;
}

export interface EsmShOptions {
  /** Defaults to https://esm.sh. Any esm.sh-compatible server works. */
  origin?: string;
  /** The project's dependency ranges — pins versions and dedupes shared packages. */
  dependencies?: Record<string, string>;
  /** Serve development builds (readable React errors). Default true. */
  dev?: boolean;
}

/** A range the CDN can't fetch (`workspace:*`, `file:../x`, `link:`, git URLs). */
function isRegistryRange(range: string): boolean {
  return !/^(workspace|file|link|portal|git\+|git:|github:|https?:)/.test(range) && !range.includes('/');
}

export function createEsmShCdn(options: EsmShOptions = {}): PackageCdn {
  const origin = (options.origin ?? 'https://esm.sh').replace(/\/+$/, '');
  const dependencies = options.dependencies ?? {};
  const dev = options.dev ?? true;

  // Pin every declared dependency into each package's own graph, so `react-dom`
  // and the app share ONE `react` — two copies is the classic "invalid hook call".
  const pinned = Object.entries(dependencies)
    .filter(([, range]) => isRegistryRange(range))
    .map(([name, range]) => `${name}@${range}`)
    .sort();

  return {
    urlFor(name, subpath) {
      const range = dependencies[name];
      const versioned = range && isRegistryRange(range) ? `${name}@${range}` : name;
      const params: string[] = [];
      const deps = pinned.filter((entry) => !entry.startsWith(name + '@'));
      if (deps.length) params.push('deps=' + deps.map(encodeURIComponent).join(','));
      if (dev) params.push('dev');
      return `${origin}/${versioned}${subpath}${params.length ? '?' + params.join('&') : ''}`;
    },
  };
}
