/**
 * Where a bare import (`react`, `react-dom/client`) is fetched from. A PORT, so a
 * fork can point at a self-hosted mirror or an offline cache without touching the
 * rest of the runtime. The default speaks esm.sh's URL scheme.
 */
export interface PackageCdn {
  /** The ES-module URL for `name` + `subpath` (`'' | '/client'`). */
  urlFor(name: string, subpath: string): string;
}

/**
 * Makes the CDN for one project, from its dependency ranges. `dev` is true for the
 * dev server and false for a production build, so a factory can pick development
 * or production package builds (React's readable errors vs its small bundle).
 * It may be async: the esm.sh one loads package metadata first.
 */
export type PackageCdnFactory = (
  dependencies: Record<string, string>,
  options: { dev: boolean },
) => PackageCdn | Promise<PackageCdn>;

/** The package.json fields that say which other packages a package imports. */
export interface PackageDependencyFields {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** esm.sh, pinned to the project's ranges, with each declared package's manifest loaded. */
export const esmShCdnFactory: PackageCdnFactory = async (dependencies, { dev }) =>
  createEsmShCdn({ dependencies, dev, manifests: await loadPackageManifests(dependencies) });

export interface EsmShOptions {
  /** Defaults to https://esm.sh. Any esm.sh-compatible server works. */
  origin?: string;
  /** The project's dependency ranges — pins versions and dedupes shared packages. */
  dependencies?: Record<string, string>;
  /** Serve development builds (readable React errors). Default true. */
  dev?: boolean;
  /**
   * Each declared package's own dependency fields, by name. They decide which pins
   * go on that package's URL (see `urlFor`). A declared package missing here falls
   * back to carrying every other pin.
   */
  manifests?: Record<string, PackageDependencyFields>;
}

/** A range the CDN can't fetch (`workspace:*`, `file:../x`, `link:`, git URLs). */
export function isRegistryRange(range: string): boolean {
  return !/^(workspace|file|link|portal|git\+|git:|github:|https?:)/.test(range) && !range.includes('/');
}

function importsPackage(manifest: PackageDependencyFields, name: string): boolean {
  return [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies].some((field) => !!field && name in field);
}

export function createEsmShCdn(options: EsmShOptions = {}): PackageCdn {
  const origin = (options.origin ?? 'https://esm.sh').replace(/\/+$/, '');
  const dependencies = options.dependencies ?? {};
  const manifests = options.manifests ?? {};
  const dev = options.dev ?? true;

  const pinned = Object.entries(dependencies)
    .filter(([, range]) => isRegistryRange(range))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    urlFor(name, subpath) {
      const range = dependencies[name];
      const declared = !!range && isRegistryRange(range);
      const versioned = declared ? `${name}@${range}` : name;
      // ONE React means the app must import the very module esm.sh links a package's
      // own imports to. When esm.sh builds `react-dom?deps=react@x`, its `import
      // 'react'` becomes `react@x` pinned with only the deps REACT itself imports
      // (none), i.e. the plain build. Pinning every other declared package onto
      // `react` too made the app load a second `?deps=react-dom,…` copy, and its
      // first `useState` read a null dispatcher. So a declared package carries only
      // the pins it imports. An undeclared one (nothing links to it by name) and one
      // whose manifest could not load carry every pin, which is what dedupes the
      // packages THEY import.
      const manifest = declared ? manifests[name] : undefined;
      const deps = pinned
        .filter(([other]) => other !== name && (!manifest || importsPackage(manifest, other)))
        .map(([other, otherRange]) => `${other}@${otherRange}`);
      const params: string[] = [];
      if (deps.length) params.push('deps=' + deps.map(encodeURIComponent).join(','));
      if (dev) params.push('dev');
      return `${origin}/${versioned}${subpath}${params.length ? '?' + params.join('&') : ''}`;
    },
  };
}

export interface ManifestLoadOptions {
  /** Defaults to https://esm.sh, which serves `<name>@<range>/package.json`. */
  origin?: string;
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

const manifestCache = new Map<string, Promise<PackageDependencyFields | undefined>>();

/**
 * The dependency fields of every declared registry package, fetched in parallel and
 * kept for the session (a range resolves the same way for its lifetime). A package
 * whose manifest cannot be fetched is simply absent, and `createEsmShCdn` falls
 * back to pinning everything onto it.
 */
export async function loadPackageManifests(
  dependencies: Record<string, string>,
  options: ManifestLoadOptions = {},
): Promise<Record<string, PackageDependencyFields>> {
  const origin = (options.origin ?? 'https://esm.sh').replace(/\/+$/, '');
  const fetcher = options.fetch ?? (typeof fetch === 'function' ? (url: string) => fetch(url) : undefined);
  if (!fetcher) return {};
  const entries = await Promise.all(
    Object.entries(dependencies)
      .filter(([, range]) => isRegistryRange(range))
      .map(async ([name, range]) => {
        const url = `${origin}/${name}@${range}/package.json`;
        let pending = manifestCache.get(url);
        if (!pending) {
          pending = fetcher(url)
            .then(async (res) => (res.ok ? ((await res.json()) as PackageDependencyFields) : undefined))
            .catch(() => undefined);
          manifestCache.set(url, pending);
        }
        return [name, await pending] as const;
      }),
  );
  const loaded: Record<string, PackageDependencyFields> = {};
  for (const [name, manifest] of entries) if (manifest) loaded[name] = manifest;
  return loaded;
}
