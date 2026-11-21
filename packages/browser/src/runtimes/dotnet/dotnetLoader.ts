/**
 * Loading the .NET runtime bundle (the npm package @seanhogg/builderforce-webcontainers-dotnet, or built with scripts/build-dotnet-runtime.mjs) into a
 * .NET process Worker: its manifest, then Mono's `dotnet.js` from the bundle
 * by URL (never bundled into this package, like Pyodide and php-wasm), started
 * with the process's environment, given the Worker's functions (module
 * `bfwc`), and the host program's exports looked up. Reference assemblies are
 * fetched only when a build needs them, one pack per group, and written into
 * the runtime's file system.
 *
 * Integrity: the manifest lists every bundle file's SHA-256. `dotnet.js` is
 * checked before it is imported — it embeds Mono's boot config, whose SRI
 * hashes Mono applies to every other `_framework` asset it fetches — and each
 * reference pack is checked whole, then each packed file's bounds and hash,
 * before anything is written. A mismatch refuses the bundle.
 *
 * Caching: where the Cache API exists (browsers), the bundle's files are kept
 * in a cache named after the manifest's hash, so `dotnet build` then `dotnet
 * run` (two processes, two Workers) download each file once; a new bundle is a
 * new cache, and older ones are dropped. Each process still boots its own Mono
 * (a Worker's realm holds one runtime).
 *
 * The slice of the .NET runtime's JavaScript API the Worker uses is typed here,
 * so the package's public types never depend on it.
 */
import type { WrappableEmscriptenFs } from '../emscripten/wrappedFsWrites.js';
import { DOTNET_BUNDLE, DOTNET_BUNDLE_SOURCE } from './dotnetBundle.js';

/** One reference assembly inside a group's pack. */
export interface PackedFile {
  name: string;
  offset: number;
  length: number;
  /** Hex SHA-256 of the file's bytes. */
  sha256: string;
}

/** `manifest.json` at the bundle's root. */
export interface DotnetBundleManifest {
  format: number;
  sdkVersion: string;
  runtimeVersion: string;
  targetFramework: string;
  /** dotnet.js, relative to the bundle. */
  entry: string;
  /** The host program's assembly name. */
  assembly: string;
  references: Record<string, { pack: string; files: PackedFile[] }>;
  /** Lower-cased package id → its reference files (`<group>/<file>`). */
  packages: Record<string, { name: string; version: string; references: string[] }>;
  /** Every bundle file (relative path) → hex SHA-256 of its bytes. */
  files: Record<string, string>;
}

/** The host program's exports (dotnet-host/Interop.cs `Exports`). */
export interface DotnetExports {
  Init(): void;
  Build(planJson: string): Promise<number>;
  Run(assemblyPath: string, args: string[], cwd: string): Promise<number>;
  Request(reqId: number, port: number, method: string, url: string, headersJson: string, body: Uint8Array): void;
  CancelRequest(reqId: number): void;
  Stop(): void;
  TcpData(connId: number, data: Uint8Array): void;
  TcpClosed(connId: number): void;
  Flush(): void;
}

/** What the Worker gives the host program (dotnet-host/Interop.cs `Js`). */
export interface DotnetImports {
  stdout(text: string): void;
  stderr(text: string): void;
  listen(port: number): boolean;
  unlisten(port: number): void;
  respondHead(reqId: number, status: number, headersJson: string): void;
  respondChunk(reqId: number, data: Uint8Array): void;
  respondEnd(reqId: number, error: string | null): void;
  dial(port: number): Promise<number>;
  send(connId: number, data: Uint8Array): void;
  hangUp(connId: number): void;
}

/** A started runtime. */
export interface LoadedDotnet {
  exports: DotnetExports;
  /** Mono's Emscripten FS: no `trackingDelegate`, so its writes are heard by wrapping its calls (as php-wasm's). */
  FS: WrappableEmscriptenFs;
  manifest: DotnetBundleManifest;
  /** Write the named reference groups into the file system (once each): their files' paths. */
  mountReferences(groups: readonly string[]): Promise<Map<string, string>>;
}

export interface DotnetLoadOptions {
  /** Where the bundle is served (absolute, CORS-enabled; in relay mode, reachable from the preview origin). */
  bundleUrl: string;
  env: Record<string, string>;
  imports: DotnetImports;
  /** The runtime exited by itself (`Environment.Exit`). */
  onExit?(code: number): void;
  /** Default `fetch`. */
  fetch?: typeof fetch;
  /** Default `import(url)`. */
  importModule?(url: string): Promise<unknown>;
}

/** The bundle cannot be used (absent, unreachable, the wrong format, or not what its manifest says): a one-line reason, no stack. */
export class DotnetBundleError extends Error {
  override readonly name = 'DotnetBundleError';
}

/** Where reference groups are written in the runtime's file system. */
export const REFERENCE_ROOT = '/dotnet/refs';

/** Cache API caches holding a bundle's files are named this, then the manifest's hash. */
export const BUNDLE_CACHE_PREFIX = 'bfwc-dotnet-';

type ResourceLoader = (type: string, name: string, defaultUri: string, integrity: string, behavior: string) => string | Promise<Response> | null | undefined;

interface DotnetBuilder {
  withEnvironmentVariables(env: Record<string, string>): DotnetBuilder;
  withModuleConfig(config: Record<string, unknown>): DotnetBuilder;
  withConfig(config: Record<string, unknown>): DotnetBuilder;
  withResourceLoader(loader: ResourceLoader): DotnetBuilder;
  create(): Promise<DotnetRuntimeApi>;
}

interface DotnetRuntimeApi {
  Module: { FS: WrappableEmscriptenFs };
  setModuleImports(name: string, imports: object): void;
  getAssemblyExports(assembly: string): Promise<Record<string, unknown>>;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The host program's exports inside `getAssemblyExports`'s namespace tree (`Bfwc.Host.Exports`). */
function exportsOf(tree: Record<string, unknown>): DotnetExports {
  const exports = (tree as { Bfwc?: { Host?: { Exports?: DotnetExports } } }).Bfwc?.Host?.Exports;
  if (!exports) throw new DotnetBundleError('The .NET runtime bundle has no Bfwc.Host.Exports: it was not built from dotnet-host/.');
  return exports;
}

/** `fetch`, with an unreachable host as a {@link DotnetBundleError}. */
async function reach(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    throw new DotnetBundleError(`The .NET runtime bundle could not be reached (${url}: ${messageOf(error)}).`);
  }
}

async function readManifestText(bundleUrl: string, fetchFn: typeof fetch): Promise<{ manifest: DotnetBundleManifest; text: string }> {
  const url = `${withSlash(bundleUrl)}manifest.json`;
  const response = await reach(fetchFn, url);
  if (!response.ok) throw new DotnetBundleError(`The .NET runtime bundle's manifest could not be loaded (${url}: HTTP ${response.status}).`);
  const text = await response.text();
  let manifest: DotnetBundleManifest;
  try {
    manifest = JSON.parse(text) as DotnetBundleManifest;
  } catch {
    throw new DotnetBundleError(`The .NET runtime bundle's manifest (${url}) is not JSON.`);
  }
  if (manifest?.format !== DOTNET_BUNDLE.format) throw new DotnetBundleError(`The .NET runtime bundle at ${bundleUrl} is format ${String(manifest?.format)}; this runtime reads format ${DOTNET_BUNDLE.format}. To get one this runtime reads, ${DOTNET_BUNDLE_SOURCE}.`);
  return { manifest, text };
}

/** Read and check a bundle's manifest. */
export async function readManifest(bundleUrl: string, fetchFn: typeof fetch = fetch): Promise<DotnetBundleManifest> {
  return (await readManifestText(bundleUrl, fetchFn)).manifest;
}

/** A fetch that keeps successful answers in the bundle's cache (where the Cache API exists), and drops older bundles' caches. */
async function bundleFetch(manifestText: string, fetchFn: typeof fetch): Promise<(url: string, init?: RequestInit) => Promise<Response>> {
  const store = (globalThis as { caches?: CacheStorage }).caches;
  if (!store) return (url, init) => reach(fetchFn, url, init);
  const name = `${BUNDLE_CACHE_PREFIX}${(await sha256Hex(new TextEncoder().encode(manifestText))).slice(0, 32)}`;
  let cache: Cache | undefined;
  try {
    cache = await store.open(name);
    for (const old of await store.keys()) if (old.startsWith(BUNDLE_CACHE_PREFIX) && old !== name) void store.delete(old);
  } catch {
    cache = undefined; // storage refused (private mode, quota): fetch every time
  }
  return async (url, init) => {
    const hit = await cache?.match(url).catch(() => undefined);
    if (hit) return hit;
    const response = await reach(fetchFn, url, init);
    if (response.ok && cache) await cache.put(url, response.clone()).catch(() => undefined);
    return response;
  };
}

/** The bytes at `path` in the bundle, checked against the manifest's hash. */
async function verifiedBytes(get: (url: string) => Promise<Response>, base: string, manifest: DotnetBundleManifest, path: string): Promise<Uint8Array> {
  const expected = manifest.files?.[path];
  if (!expected) throw new DotnetBundleError(`The .NET runtime bundle's manifest has no hash for ${path}: to get a complete one, ${DOTNET_BUNDLE_SOURCE}.`);
  const response = await get(new URL(path, base).href);
  if (!response.ok) throw new DotnetBundleError(`${path} of the .NET runtime bundle could not be loaded (HTTP ${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Hex(bytes)) !== expected) throw new DotnetBundleError(`${path} of the .NET runtime bundle does not match its manifest's hash: refusing it.`);
  return bytes;
}

/** The packed files of a reference group, bounds- and hash-checked against the pack. */
async function unpack(group: string, pack: Uint8Array, files: readonly PackedFile[]): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const out: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const file of files) {
    const { offset, length } = file;
    const inBounds = Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset + length <= pack.byteLength;
    if (!inBounds || !/^[\w.-]+\.dll$/i.test(file.name)) throw new DotnetBundleError(`The "${group}" reference pack's entry ${JSON.stringify(file.name)} is out of bounds or misnamed: refusing it.`);
    const bytes = pack.subarray(offset, offset + length);
    if ((await sha256Hex(bytes)) !== file.sha256) throw new DotnetBundleError(`${group}/${file.name} does not match its manifest's hash: refusing it.`);
    out.push({ name: file.name, bytes });
  }
  return out;
}

/** Start the runtime. One per Worker: Mono's runtime is a singleton of its JavaScript realm. */
export async function loadDotnetRuntime(options: DotnetLoadOptions): Promise<LoadedDotnet> {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const base = withSlash(options.bundleUrl);
  const { manifest, text } = await readManifestText(base, fetchFn);
  const get = await bundleFetch(text, fetchFn);
  // dotnet.js embeds Mono's boot config (every other asset's SRI hash): check it before it runs.
  await verifiedBytes(get, base, manifest, manifest.entry);
  const load = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const { dotnet } = (await load(new URL(manifest.entry, base).href)) as { dotnet: DotnetBuilder };
  let builder = dotnet.withEnvironmentVariables(options.env).withModuleConfig({ onExit: (code: number) => options.onExit?.(code) });
  // Mono's assets through the bundle's cache, with Mono's own integrity hash on a network fetch. dotnet.js itself must stay a URL.
  if ((globalThis as { caches?: CacheStorage }).caches) builder = builder.withResourceLoader((type, _name, uri, integrity) => (type === 'dotnetjs' ? undefined : get(uri, integrity ? { integrity } : undefined)));
  const runtime = await builder.create();
  runtime.setModuleImports('bfwc', options.imports);
  const exports = exportsOf(await runtime.getAssemblyExports(manifest.assembly));
  const FS = runtime.Module.FS;
  const mounted = new Map<string, Map<string, string>>();

  async function mountGroup(group: string): Promise<Map<string, string>> {
    const existing = mounted.get(group);
    if (existing) return existing;
    const entry = manifest.references[group];
    if (!entry) throw new DotnetBundleError(`The .NET runtime bundle has no "${group}" reference assemblies.`);
    const files = await unpack(group, await verifiedBytes(get, base, manifest, entry.pack), entry.files);
    const dir = `${REFERENCE_ROOT}/${group}`;
    FS.mkdirTree(dir);
    const paths = new Map<string, string>();
    for (const file of files) {
      const path = `${dir}/${file.name}`;
      FS.writeFile(path, file.bytes);
      paths.set(`${group}/${file.name}`, path);
    }
    mounted.set(group, paths);
    return paths;
  }

  return {
    exports,
    FS,
    manifest,
    async mountReferences(groups) {
      const all = new Map<string, string>();
      for (const group of new Set(groups)) for (const [key, path] of await mountGroup(group)) all.set(key, path);
      return all;
    },
  };
}
