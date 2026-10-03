import type * as TS from 'typescript';
import { isRegistryRange } from '../packageCdn.js';
import { splitPackageSpecifier } from '../resolve.js';

/**
 * Where the checker's non-project files live, and the cache that holds them.
 *
 * A TypeScript program is synchronous, but type definitions come from the
 * network. So checking is two phases: acquisition fetches everything the project
 * can reach into a {@link TypeStore}; the program then reads only the store. The
 * store outlives one check (a worker keeps it), so a second check of the same
 * project makes no requests and reuses parsed lib files.
 *
 * Fetched files are addressed by URL and exposed to TypeScript under virtual
 * paths; libs and `extends`-ed tsconfig packages likewise.
 */

export const TYPES_DIR = '/__bfwc_types__';
export const LIB_DIR = '/__bfwc_lib__';
/** tsconfig `extends: "@vue/tsconfig/..."` resolves through node_modules, so fetched configs live there. */
export const CONFIG_MODULES_DIR = '/node_modules';

export interface TypeSources {
  /** An esm.sh-compatible CDN: answers `X-TypeScript-Types` for a package URL. */
  typesOrigin: string;
  /** Directory holding `lib.*.d.ts` for the TypeScript version in use. */
  libBaseUrl: string;
  /** Raw npm files (for tsconfig `extends` packages), jsDelivr's `/npm` layout. */
  npmBaseUrl: string;
}

export const DEFAULT_TYPES_ORIGIN = 'https://esm.sh';
export const DEFAULT_NPM_BASE_URL = 'https://cdn.jsdelivr.net/npm';

export function libBaseUrlFor(typescriptVersion: string): string {
  return `${DEFAULT_NPM_BASE_URL}/typescript@${typescriptVersion}/lib`;
}

/** `@scope/name` → `@types/scope__name`, DefinitelyTyped's naming. */
export function typesPackageName(name: string): string {
  return `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;
}

/** `name@range` when the project declares a registry range for it, else `name`. */
export function versioned(name: string, dependencies: Readonly<Record<string, string>>): string {
  const range = dependencies[name];
  return range && isRegistryRange(range) ? `${name}@${range}` : name;
}

/** The CDN module URL whose `X-TypeScript-Types` names a specifier's types. */
export function packageRequestUrl(origin: string, specifier: string, dependencies: Readonly<Record<string, string>>): string {
  const { name, subpath } = splitPackageSpecifier(specifier);
  return `${origin}/${versioned(name, dependencies)}${subpath}`;
}

/** URLs to try, in order, for a relative or absolute reference inside a fetched `.d.ts`. */
export function dtsCandidates(specifier: string, fromUrl: string): string[] {
  const url = new URL(specifier, fromUrl).href.replace(/[?#].*$/, '');
  if (/\.d\.[mc]?ts$/.test(url)) return [url];
  if (/\.[mc]?js$/.test(url)) return [url.replace(/\.([mc]?)js$/, '.d.$1ts')];
  if (/\.[mc]?ts$/.test(url)) return [url];
  return [`${url}.d.ts`, `${url}/index.d.ts`];
}

export class TypeStore {
  /** Final (post-redirect) URL → text. */
  readonly files = new Map<string, string>();
  /** Requested URL → final URL; `''` records a failure so it is not retried. */
  readonly redirects = new Map<string, string>();
  /** Package request URL (or `types:<name>`) → final types URL, or null when it has none. */
  readonly packages = new Map<string, string | null>();
  /** `lib.dom.d.ts` → text, or null when missing. */
  readonly libs = new Map<string, string | null>();
  /** `/node_modules/@vue/tsconfig/tsconfig.json` → text, or null when missing. */
  readonly configs = new Map<string, string | null>();
  /** Parsed lib and package files, reused by every program built over this store. */
  readonly sourceFiles = new Map<string, TS.SourceFile>();

  /** The final URL for a requested one, when it was fetched. */
  finalUrl(url: string): string | undefined {
    const final = this.redirects.get(url) ?? (this.files.has(url) ? url : undefined);
    return final || undefined;
  }

  virtualPath(url: string): string {
    return `${TYPES_DIR}/${url.replace(/^[a-z]+:\/\//i, '')}`;
  }

  urlOf(virtualPath: string): string | undefined {
    if (!virtualPath.startsWith(`${TYPES_DIR}/`)) return undefined;
    const rest = virtualPath.slice(TYPES_DIR.length + 1);
    for (const scheme of ['https://', 'http://']) if (this.files.has(scheme + rest)) return scheme + rest;
    return undefined;
  }

  /** Text for any virtual non-project path, or undefined. */
  read(path: string): string | undefined {
    if (path.startsWith(`${LIB_DIR}/`)) return this.libs.get(path.slice(LIB_DIR.length + 1)) ?? undefined;
    if (path.startsWith(`${CONFIG_MODULES_DIR}/`)) return this.configs.get(path) ?? undefined;
    const url = this.urlOf(path);
    return url ? this.files.get(url) : undefined;
  }
}
