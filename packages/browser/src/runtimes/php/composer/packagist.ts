/**
 * Where Composer packages come from: Packagist's metadata, and each version's
 * files.
 *
 * Metadata: by default Packagist's package API
 * (`https://packagist.org/packages/<name>.json`) — the one Packagist endpoint
 * that answers browsers (CORS) — or a host's repository URL template
 * (`{name}`), which may also answer in Composer v2's minified `p2` format
 * (expanded here).
 *
 * Files: a version's dist zip, fetched directly or through the host's dist
 * proxy (a URL prefix) and unpacked with the core's `importZip` (zip-bomb
 * limits) — GitHub's zipballs do not answer browsers, so without a proxy a
 * GitHub-hosted package is fetched file by file from jsDelivr's GitHub mirror
 * (CORS) at the locked commit instead — only when the zip cannot be fetched at
 * all. Both ways are held to the same limits (entries, bytes per file and in
 * all, response size), and a dist whose metadata carries a `shasum` must match
 * it; a refusal ({@link DistRefused}) is final, never retried another way.
 * Package names are validated and URL-encoded per segment (packageName.ts).
 */
import { VirtualFileSystem, ZipLimitError, importZip } from '@seanhogg/builderforce-webcontainers-core';
import { checkPackageName, encodePackageName } from './packageName.js';

/** A package version as Composer metadata describes it (and composer.lock stores it). */
export interface PackageVersion {
  name: string;
  version: string;
  version_normalized?: string;
  type?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
  replace?: Record<string, string>;
  provide?: Record<string, string>;
  autoload?: Autoload;
  dist?: { type?: string; url?: string; reference?: string; shasum?: string } | null;
  source?: { type?: string; url?: string; reference?: string } | null;
  [key: string]: unknown;
}

export interface Autoload {
  'psr-4'?: Record<string, string | string[]>;
  'psr-0'?: Record<string, string | string[]>;
  classmap?: string[];
  files?: string[];
  'exclude-from-classmap'?: string[];
}

export interface PackageSourceOptions {
  /** Metadata URL template with `{name}`. Default {@link DEFAULT_REPOSITORY_URL}. */
  repositoryUrl?: string;
  /** A URL prefix dist URLs are appended to (encoded), for hosts that proxy GitHub's zipballs. */
  distProxy?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_REPOSITORY_URL = 'https://packagist.org/packages/{name}.json';
export const JSDELIVR_GITHUB = 'https://cdn.jsdelivr.net/gh/';
export const JSDELIVR_GITHUB_LISTING = 'https://data.jsdelivr.com/v1/packages/gh/';

/** Expand Composer v2's minified version list (each entry inherits the previous one's keys; `__unset` removes one). */
export function expandMinified(versions: ReadonlyArray<Record<string, unknown>>): PackageVersion[] {
  const out: PackageVersion[] = [];
  let previous: Record<string, unknown> = {};
  for (const entry of versions) {
    const expanded: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(entry)) {
      if (value === '__unset') delete expanded[key];
      else expanded[key] = value;
    }
    out.push(expanded as PackageVersion);
    previous = expanded;
  }
  return out;
}

/** A package's versions from a metadata answer (Packagist's package API, or `p2`); undefined when it holds none. */
export function versionsOf(name: string, body: unknown): PackageVersion[] | undefined {
  const document = body as { package?: { versions?: Record<string, PackageVersion> }; packages?: Record<string, Array<Record<string, unknown>> | Record<string, PackageVersion>>; minified?: string };
  if (document.package?.versions) return Object.values(document.package.versions).map((version) => ({ ...version, name }));
  const listed = document.packages?.[name];
  if (Array.isArray(listed)) return (document.minified ? expandMinified(listed) : (listed as PackageVersion[])).map((version) => ({ ...version, name }));
  if (listed) return Object.values(listed).map((version) => ({ ...version, name }));
  return undefined;
}

export interface PackageSource {
  /** Every version of `name`; undefined when the repository does not have it. */
  versions(name: string): Promise<PackageVersion[] | undefined>;
  /** The files of `version`, relative to its root (the zip's single top directory stripped). */
  files(version: PackageVersion): Promise<Map<string, Uint8Array>>;
}

/** A GitHub repository's owner and name from a dist or source URL. */
export function githubRepository(url: string | undefined): { owner: string; repo: string } | undefined {
  const match = url && /^https:\/\/(?:api\.)?github\.com\/(?:repos\/)?([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(url);
  return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

/** What one package may unpack to, whichever way its files arrive. */
export const DIST_LIMITS = { maxEntries: 50_000, maxTotalBytes: 256 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024 } as const;
/** The largest response read: a dist zip, a metadata document. */
export const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

/** A dist past {@link DIST_LIMITS} or {@link MAX_RESPONSE_BYTES}, or whose checksum does not match: never retried another way. */
export class DistRefused extends Error {}

/** A zip's files with its single top-level directory (GitHub's `owner-repo-sha/`) stripped, within {@link DIST_LIMITS}. */
export function unpackDist(zip: Uint8Array): Map<string, Uint8Array> {
  const fs = new VirtualFileSystem();
  try {
    importZip(fs, zip, '/', DIST_LIMITS);
  } catch (error) {
    if (error instanceof ZipLimitError) throw new DistRefused(error.message);
    throw error;
  }
  const paths = fs.list();
  const tops = new Set(paths.map((path) => path.split('/')[1]));
  const strip = tops.size === 1 && paths.every((path) => path.split('/').length > 2) ? `/${[...tops][0]}/` : '/';
  const files = new Map<string, Uint8Array>();
  for (const path of paths) {
    const content = fs.readFile(path);
    files.set(path.slice(strip.length), typeof content === 'string' ? new TextEncoder().encode(content) : (content ?? new Uint8Array()));
  }
  return files;
}

async function fetchOk(fetcher: typeof fetch, url: string): Promise<Response> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
  return response;
}

/** A response's body, refused past `max` bytes (by its Content-Length, or as it streams). */
export async function readCapped(response: Response, max: number, what: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) throw new DistRefused(`${what} is ${declared} bytes, over the ${max}-byte limit.`);
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new DistRefused(`${what} exceeds the ${max}-byte limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Refuse `bytes` unless their SHA-1 is `shasum` (when the metadata gives one). */
async function verifyShasum(bytes: Uint8Array<ArrayBuffer>, shasum: string | undefined, what: string): Promise<void> {
  if (!shasum) return;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex !== shasum.toLowerCase()) throw new DistRefused(`${what}: checksum mismatch (sha1 ${hex}, metadata says ${shasum}).`);
}

/**
 * A dist URL the metadata gave: absolute `https:` only — or `http:` to a
 * loopback host (a local mirror) — never a relative, `file:`, `data:` or
 * plain-HTTP remote URL.
 */
export function checkDistUrl(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DistRefused(`${what}: dist URL "${url}" is not an absolute URL.`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127\./.test(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) throw new DistRefused(`${what}: dist URL "${url}" is not https.`);
}

const SAFE_SEGMENT =/^[A-Za-z0-9._-]+$/;

/** A GitHub repository at a commit, file by file from jsDelivr (which answers browsers), within {@link DIST_LIMITS}. */
async function githubFiles(fetcher: typeof fetch, owner: string, repo: string, ref: string): Promise<Map<string, Uint8Array>> {
  if (![owner, repo, ref].every((segment) => SAFE_SEGMENT.test(segment))) throw new DistRefused(`Refusing GitHub source ${owner}/${repo}@${ref}: not a plain repository and commit.`);
  const listing = JSON.parse(new TextDecoder().decode(await readCapped(await fetchOk(fetcher, `${JSDELIVR_GITHUB_LISTING}${owner}/${repo}@${ref}?structure=flat`), MAX_RESPONSE_BYTES, 'The jsDelivr listing'))) as { files?: Array<{ name: string; size?: number }> };
  const names = (listing.files ?? []).map((file) => file.name);
  if (names.length > DIST_LIMITS.maxEntries) throw new DistRefused(`${owner}/${repo} has ${names.length} files, over the ${DIST_LIMITS.maxEntries}-entry limit.`);
  for (const name of names) if (!name.startsWith('/') || name.split('/').some((segment) => segment === '..' || segment === '.')) throw new DistRefused(`Refusing file "${name}" in ${owner}/${repo}.`);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < names.length; i += 8) {
    await Promise.all(
      names.slice(i, i + 8).map(async (name) => {
        const bytes = await readCapped(await fetchOk(fetcher, `${JSDELIVR_GITHUB}${owner}/${repo}@${ref}${name.split('/').map(encodeURIComponent).join('/')}`), DIST_LIMITS.maxEntryBytes, name);
        total += bytes.byteLength;
        if (total > DIST_LIMITS.maxTotalBytes) throw new DistRefused(`${owner}/${repo} exceeds the ${DIST_LIMITS.maxTotalBytes}-byte limit.`);
        files.set(name.slice(1), bytes);
      }),
    );
  }
  return files;
}

export function createPackageSource(options: PackageSourceOptions = {}): PackageSource {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const template = options.repositoryUrl ?? DEFAULT_REPOSITORY_URL;
  const cache = new Map<string, Promise<PackageVersion[] | undefined>>();
  return {
    versions(requested) {
      let name: string;
      try {
        name = checkPackageName(requested, 'a package request');
      } catch (error) {
        return Promise.reject(error);
      }
      let found = cache.get(name);
      if (!found) {
        found = (async () => {
          const response = await fetcher(template.replace('{name}', encodePackageName(name)));
          if (response.status === 404) return undefined;
          if (!response.ok) throw new Error(`Package metadata for ${name}: ${response.status} ${response.statusText}`);
          return versionsOf(name, JSON.parse(new TextDecoder().decode(await readCapped(response, MAX_RESPONSE_BYTES, `Package metadata for ${name}`))));
        })();
        cache.set(name, found);
      }
      return found;
    },
    async files(version) {
      const dist = version.dist;
      const github = githubRepository(dist?.url) ?? githubRepository(version.source?.url ?? undefined);
      const ref = dist?.reference ?? version.source?.reference;
      const what = `${version.name} ${version.version}`;
      if (dist?.url && (dist.type ?? 'zip') === 'zip') {
        checkDistUrl(dist.url, what);
        const url = options.distProxy ? `${options.distProxy}${encodeURIComponent(dist.url)}` : dist.url;
        let response: Response | undefined;
        try {
          response = await fetchOk(fetcher, url);
        } catch (error) {
          // Only a failed fetch (a browser cannot read GitHub's zipballs: no CORS) falls back to jsDelivr at the same commit.
          if (!github || !ref || options.distProxy) throw error;
        }
        if (response) {
          // Past here a refusal (size, zip limits, checksum) is final: no fallback can bypass it.
          const zip = await readCapped(response, MAX_RESPONSE_BYTES, what);
          await verifyShasum(zip, dist.shasum, what);
          return unpackDist(zip);
        }
      }
      if (github && ref) return githubFiles(fetcher, github.owner, github.repo, ref);
      throw new Error(`${what} has no zip dist or GitHub source the PHP runtime can fetch.`);
    },
  };
}
