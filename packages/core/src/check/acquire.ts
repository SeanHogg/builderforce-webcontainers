import type * as TS from 'typescript';
import { isBareSpecifier, splitPackageSpecifier } from '../resolve.js';
import { dirname, join } from '../paths.js';
import { parseLooseJson } from '../projectConfig.js';
import type { VirtualFileSystem } from '../vfs.js';
import { SHIMMED_TYPE_REFERENCES } from './shims.js';
import {
  CONFIG_MODULES_DIR,
  dtsCandidates,
  packageRequestUrl,
  typesPackageName,
  versioned,
  type TypeSources,
  type TypeStore,
} from './typeStore.js';

/** The part of a fetch `Response` acquisition reads; the real `fetch` satisfies it. */
export interface FetchResponseLike {
  ok: boolean;
  /** The final URL after redirects. Relative references resolve against it. */
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface AcquireRequest {
  /** Bare module specifiers imported by project files (`react`, `react/jsx-runtime`). */
  specifiers: string[];
  /** `types` entries and `/// <reference types>` names. */
  typeReferences: string[];
  /** Lib file names (`lib.es2020.full.d.ts`). */
  libFiles: string[];
  dependencies: Readonly<Record<string, string>>;
}

export interface AcquireOptions {
  fetch: FetchLike;
  sources: TypeSources;
  /** Upper bound on fetched `.d.ts` files — one run-away graph must not stall a check. */
  maxFiles: number;
}

const TYPES_HEADER = 'X-TypeScript-Types';

/**
 * Fetch every declaration file the request can reach into the store: package
 * entry types (via the CDN's `X-TypeScript-Types` header), then everything those
 * import or reference, transitively; lib files and their `/// <reference lib>`s.
 *
 * Fetches run concurrently. Each URL is fetched once and its references are
 * scheduled rather than awaited inside the fetch, so reference cycles between
 * declaration files cannot deadlock.
 */
export async function acquireTypes(ts: typeof TS, store: TypeStore, request: AcquireRequest, options: AcquireOptions): Promise<void> {
  const { sources } = options;
  const inflight = new Map<string, Promise<unknown>>();
  const tasks: Promise<unknown>[] = [];
  const schedule = (task: () => Promise<unknown>) => tasks.push(task().catch(() => undefined));
  const once = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    if (!inflight.has(key)) inflight.set(key, task());
    return inflight.get(key) as Promise<T>;
  };
  const get = (url: string) => options.fetch(url).then((res) => (res.ok ? res : undefined), () => undefined);

  function walk(fromUrl: string, text: string): void {
    const info = ts.preProcessFile(text, true, true);
    for (const ref of info.referencedFiles) schedule(() => fetchFirst(dtsCandidates(ref.fileName, fromUrl)));
    for (const ref of info.typeReferenceDirectives) schedule(() => ensureTypeReference(ref.fileName));
    for (const ref of info.libReferenceDirectives) schedule(() => ensureLib(`lib.${ref.fileName.toLowerCase()}.d.ts`));
    for (const ref of info.importedFiles) {
      const spec = ref.fileName;
      schedule(() => (isBareSpecifier(spec) ? ensurePackage(spec) : fetchFirst(dtsCandidates(spec, fromUrl))));
    }
  }

  /** Fetch one declaration file; resolves to its final URL. */
  function fetchDts(url: string): Promise<string | undefined> {
    const known = store.redirects.get(url);
    if (known !== undefined) return Promise.resolve(known || undefined);
    if (store.files.has(url)) return Promise.resolve(url);
    return once(`dts:${url}`, async () => {
      if (store.files.size >= options.maxFiles) return undefined;
      const res = await get(url);
      if (!res) {
        store.redirects.set(url, '');
        return undefined;
      }
      const final = res.url || url;
      store.redirects.set(url, final);
      if (!store.files.has(final)) {
        const text = await res.text();
        store.files.set(final, text);
        walk(final, text);
      }
      return final;
    });
  }

  async function fetchFirst(candidates: string[]): Promise<string | undefined> {
    for (const url of candidates) {
      const final = await fetchDts(url);
      if (final) return final;
    }
    return undefined;
  }

  /** A bare specifier's entry types, located by the CDN's header. */
  function ensurePackage(specifier: string, dependencies: Readonly<Record<string, string>> = {}): Promise<string | undefined> {
    const key = packageRequestUrl(sources.typesOrigin, specifier, dependencies);
    if (store.packages.has(key)) return Promise.resolve(store.packages.get(key) ?? undefined);
    return once(`pkg:${key}`, async () => {
      const res = await get(key);
      const header = res?.headers.get(TYPES_HEADER);
      const final = header ? await fetchDts(new URL(header, res!.url || key).href) : undefined;
      store.packages.set(key, final ?? null);
      return final;
    });
  }

  /** `/// <reference types="x" />` and `types: ["x"]`: the package's own types, else DefinitelyTyped. */
  function ensureTypeReference(name: string, dependencies: Readonly<Record<string, string>> = {}): Promise<unknown> {
    if (SHIMMED_TYPE_REFERENCES.has(name)) return Promise.resolve();
    const key = `types:${name}`;
    if (store.packages.has(key)) return Promise.resolve();
    return once(key, async () => {
      // `node` is DefinitelyTyped's, not the npm package called "node".
      const own = name === 'node' ? undefined : await ensurePackage(name, dependencies);
      const { name: pkg, subpath } = splitPackageSpecifier(name);
      const typesPkg = typesPackageName(pkg);
      const definitelyTyped = own
        ? undefined
        : await fetchDts(`${sources.typesOrigin}/${versioned(typesPkg, dependencies)}${subpath || '/index'}.d.ts`);
      store.packages.set(key, own ?? definitelyTyped ?? null);
    });
  }

  function ensureLib(file: string): Promise<unknown> {
    if (store.libs.has(file)) return Promise.resolve();
    return once(`lib:${file}`, async () => {
      const res = await get(`${sources.libBaseUrl}/${file}`);
      const text = res ? await res.text() : null;
      store.libs.set(file, text);
      if (text) {
        for (const ref of ts.preProcessFile(text, true, false).libReferenceDirectives) {
          schedule(() => ensureLib(`lib.${ref.fileName.toLowerCase()}.d.ts`));
        }
      }
    });
  }

  for (const spec of request.specifiers) schedule(() => ensurePackage(spec, request.dependencies));
  for (const name of request.typeReferences) schedule(() => ensureTypeReference(name, request.dependencies));
  for (const file of request.libFiles) schedule(() => ensureLib(file));
  while (tasks.length) await Promise.all(tasks.splice(0));
}

/**
 * Fetch tsconfig files the project `extends` from packages (`@vue/tsconfig`,
 * `@tsconfig/svelte`) into the store's virtual node_modules, following their own
 * `extends` chains, so the config parser sees what a local install would hold.
 */
export async function acquireExtendedConfigs(
  fs: VirtualFileSystem,
  store: TypeStore,
  dependencies: Readonly<Record<string, string>>,
  options: Pick<AcquireOptions, 'fetch' | 'sources'>,
): Promise<void> {
  const tasks: Promise<void>[] = [];

  function extendsOf(text: string): string[] {
    try {
      const value = (parseLooseJson(text) as { extends?: unknown }).extends;
      return (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }

  function follow(fromPath: string, text: string): void {
    for (const spec of extendsOf(text)) {
      let path: string;
      if (isBareSpecifier(spec)) {
        const { name, subpath } = splitPackageSpecifier(spec);
        path = `${CONFIG_MODULES_DIR}/${name}${subpath ? (subpath.endsWith('.json') ? subpath : `${subpath}.json`) : '/tsconfig.json'}`;
      } else if (fromPath.startsWith(`${CONFIG_MODULES_DIR}/`)) {
        path = join(dirname(fromPath), spec.endsWith('.json') ? spec : `${spec}.json`);
      } else {
        continue; // a project-local config: already in the VFS
      }
      if (store.configs.has(path)) continue;
      store.configs.set(path, null);
      tasks.push(fetchConfig(path));
    }
  }

  async function fetchConfig(path: string): Promise<void> {
    const rest = path.slice(CONFIG_MODULES_DIR.length + 1);
    const { name, subpath } = splitPackageSpecifier(rest);
    const res = await options.fetch(`${options.sources.npmBaseUrl}/${versioned(name, dependencies)}${subpath}`).catch(() => undefined);
    if (!res?.ok) return;
    const text = await res.text();
    store.configs.set(path, text);
    follow(path, text);
  }

  for (const path of fs.list()) {
    if (/^\/tsconfig[^/]*\.json$/.test(path)) follow(path, fs.readText(path) ?? '');
  }
  while (tasks.length) await Promise.all(tasks.splice(0));
}
