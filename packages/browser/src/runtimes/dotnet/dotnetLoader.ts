/**
 * Loading the .NET runtime bundle (scripts/build-dotnet-runtime.mjs) into a
 * .NET process Worker: its manifest, then Mono's `dotnet.js` from the bundle
 * by URL (never bundled into this package, like Pyodide and php-wasm), started
 * with the process's environment, given the Worker's functions (module
 * `bfwc`), and the host program's exports looked up. Reference assemblies are
 * fetched only when a build needs them, one pack per group, and written into
 * the runtime's file system.
 *
 * The slice of the .NET runtime's JavaScript API the Worker uses is typed here,
 * so the package's public types never depend on it.
 */
import type { PhpEmscriptenFs } from '../php/phpLoader.js';
import { DOTNET_BUNDLE } from './dotnetBundle.js';

/** Mono's Emscripten FS: the project mirror's calls and the ones wrapped to hear the program's writes (as php-wasm's). */
export type DotnetEmscriptenFs = PhpEmscriptenFs;

/** One reference assembly inside a group's pack. */
export interface PackedFile {
  name: string;
  offset: number;
  length: number;
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
  FS: DotnetEmscriptenFs;
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

/** Where reference groups are written in the runtime's file system. */
export const REFERENCE_ROOT = '/dotnet/refs';

interface DotnetBuilder {
  withEnvironmentVariables(env: Record<string, string>): DotnetBuilder;
  withModuleConfig(config: Record<string, unknown>): DotnetBuilder;
  withConfig(config: Record<string, unknown>): DotnetBuilder;
  create(): Promise<DotnetRuntimeApi>;
}

interface DotnetRuntimeApi {
  Module: { FS: DotnetEmscriptenFs };
  setModuleImports(name: string, imports: object): void;
  getAssemblyExports(assembly: string): Promise<Record<string, unknown>>;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** The host program's exports inside `getAssemblyExports`'s namespace tree (`Bfwc.Host.Exports`). */
function exportsOf(tree: Record<string, unknown>): DotnetExports {
  const exports = (tree as { Bfwc?: { Host?: { Exports?: DotnetExports } } }).Bfwc?.Host?.Exports;
  if (!exports) throw new Error('The .NET runtime bundle has no Bfwc.Host.Exports: it was not built from dotnet-host/.');
  return exports;
}

/** Read and check a bundle's manifest. */
export async function readManifest(bundleUrl: string, fetchFn: typeof fetch = fetch): Promise<DotnetBundleManifest> {
  const url = `${withSlash(bundleUrl)}manifest.json`;
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`The .NET runtime bundle's manifest could not be loaded (${url}: HTTP ${response.status}).`);
  const manifest = (await response.json()) as DotnetBundleManifest;
  if (manifest.format !== DOTNET_BUNDLE.format) throw new Error(`The .NET runtime bundle at ${bundleUrl} is format ${String(manifest.format)}; this runtime reads format ${DOTNET_BUNDLE.format}. Rebuild it with scripts/build-dotnet-runtime.mjs.`);
  return manifest;
}

/** Start the runtime. One per Worker: Mono's runtime is a singleton of its JavaScript realm. */
export async function loadDotnetRuntime(options: DotnetLoadOptions): Promise<LoadedDotnet> {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const base = withSlash(options.bundleUrl);
  const manifest = await readManifest(base, fetchFn);
  const load = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  const { dotnet } = (await load(new URL(manifest.entry, base).href)) as { dotnet: DotnetBuilder };
  const runtime = await dotnet
    .withEnvironmentVariables(options.env)
    .withModuleConfig({ onExit: (code: number) => options.onExit?.(code) })
    .create();
  runtime.setModuleImports('bfwc', options.imports);
  const exports = exportsOf(await runtime.getAssemblyExports(manifest.assembly));
  const FS = runtime.Module.FS;
  const mounted = new Map<string, Map<string, string>>();

  async function mountGroup(group: string): Promise<Map<string, string>> {
    const existing = mounted.get(group);
    if (existing) return existing;
    const entry = manifest.references[group];
    if (!entry) throw new Error(`The .NET runtime bundle has no "${group}" reference assemblies.`);
    const response = await fetchFn(new URL(entry.pack, base).href);
    if (!response.ok) throw new Error(`The "${group}" reference assemblies could not be loaded (HTTP ${response.status}).`);
    const pack = new Uint8Array(await response.arrayBuffer());
    const dir = `${REFERENCE_ROOT}/${group}`;
    FS.mkdirTree(dir);
    const paths = new Map<string, string>();
    for (const file of entry.files) {
      const path = `${dir}/${file.name}`;
      FS.writeFile(path, pack.subarray(file.offset, file.offset + file.length));
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
