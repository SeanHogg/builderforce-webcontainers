/**
 * Talking to an npm registry: packuments (version metadata) and tarballs, both
 * through an optional cache PORT so the browser can back it with Cache Storage
 * and tests with a Map. The installer never touches `globalThis.fetch` — the
 * caller injects one, which is what keeps this testable against a fake registry.
 */

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A byte cache keyed by string. Tarballs are immutable, so they are cached forever. */
export interface PackageCache {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, data: Uint8Array): Promise<void>;
}

export function createMemoryCache(): PackageCache & { readonly size: number } {
  const store = new Map<string, Uint8Array>();
  return {
    get: async (key) => store.get(key),
    put: async (key, data) => void store.set(key, data),
    get size() {
      return store.size;
    },
  };
}

export type BinField = string | Record<string, string>;

/** One version from a packument — the fields the abbreviated format carries. */
export interface PackageManifest {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[] | boolean;
  bundledDependencies?: string[] | boolean;
  bin?: BinField;
  os?: string[];
  cpu?: string[];
  engines?: Record<string, string>;
  hasInstallScript?: boolean;
  deprecated?: string;
  license?: string;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

export interface Packument {
  name: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, PackageManifest>;
}

export interface RegistryOptions {
  fetch: FetchLike;
  registry?: string;
  cache?: PackageCache;
  /** How long a cached packument is trusted. Default 10 minutes. */
  packumentMaxAgeMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
/** The abbreviated ("corgi") document: a fraction of the full packument's size. */
const ABBREVIATED = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check `integrity` (SRI, `sha512-…`) or the legacy sha1 `shasum`. Skipped where
 * WebCrypto is missing — a tarball from the configured registry over https is
 * still trustworthy, the check only guards against a corrupt cache entry.
 */
export async function verifyIntegrity(data: Uint8Array, dist: { integrity?: string; shasum?: string }): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return true;
  const digest = async (algo: string) => new Uint8Array(await subtle.digest(algo, data as unknown as ArrayBuffer));
  if (dist.integrity) {
    const algos: Record<string, string> = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
    for (const token of dist.integrity.split(/\s+/)) {
      const dash = token.indexOf('-');
      const algo = algos[token.slice(0, dash)];
      if (algo && toBase64(await digest(algo)) === token.slice(dash + 1)) return true;
    }
    return false;
  }
  if (dist.shasum) return toHex(await digest('SHA-1')) === dist.shasum;
  return true;
}

export class RegistryClient {
  readonly registry: string;
  private readonly packuments = new Map<string, Promise<Packument>>();

  constructor(private readonly options: RegistryOptions) {
    this.registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  }

  /** Version metadata for a package, fetched once per client. */
  packument(name: string): Promise<Packument> {
    let pending = this.packuments.get(name);
    if (!pending) {
      pending = this.loadPackument(name);
      pending.catch(() => this.packuments.delete(name));
      this.packuments.set(name, pending);
    }
    return pending;
  }

  /** The tarball's bytes (still gzipped), integrity-checked. */
  async tarball(manifest: Pick<PackageManifest, 'name' | 'version' | 'dist'>): Promise<Uint8Array> {
    const { dist } = manifest;
    const key = `tarball:${dist.integrity ?? dist.shasum ?? dist.tarball}`;
    const cached = await this.options.cache?.get(key);
    if (cached && (await verifyIntegrity(cached, dist))) return cached;
    const data = await this.get(dist.tarball, {});
    if (!(await verifyIntegrity(data, dist))) throw new Error(`Integrity check failed for ${manifest.name}@${manifest.version}`);
    await this.options.cache?.put(key, data);
    return data;
  }

  private async loadPackument(name: string): Promise<Packument> {
    const key = `packument:${this.registry}/${name}`;
    const maxAge = this.options.packumentMaxAgeMs ?? 10 * 60_000;
    const cached = await this.options.cache?.get(key);
    if (cached) {
      try {
        const entry = JSON.parse(decoder.decode(cached)) as { t: number; p: Packument };
        if (Date.now() - entry.t < maxAge) return entry.p;
      } catch {
        // a corrupt entry is just a miss
      }
    }
    const url = `${this.registry}/${name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)}`;
    const bytes = await this.get(url, { accept: ABBREVIATED }, name);
    const packument = JSON.parse(decoder.decode(bytes)) as Packument;
    if (!packument.versions) throw new Error(`The registry returned no versions for "${name}".`);
    await this.options.cache?.put(key, encoder.encode(JSON.stringify({ t: Date.now(), p: packument })));
    return packument;
  }

  private async get(url: string, headers: Record<string, string>, packageName?: string): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.options.fetch(url, { headers, signal: this.options.signal });
      } catch (error) {
        if (this.options.signal?.aborted) throw error;
        lastError = error; // network blip: retry once
        continue;
      }
      if (response.status === 404 && packageName) throw new Error(`Package "${packageName}" was not found in ${this.registry}.`);
      if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    }
    throw new Error(`GET ${url} failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}
