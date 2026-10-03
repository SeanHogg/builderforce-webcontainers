import type * as TS from 'typescript';
import type { VirtualFileSystem } from '../vfs.js';
import type { PathAlias } from '../projectConfig.js';
import { dirname, extname, join, normalizePath } from '../paths.js';
import { isBareSpecifier } from '../resolve.js';
import { AMBIENT_SHIM_PATH, EMPTY_TYPES_PATH, SHIMMED_TYPE_REFERENCES, SHIM_DIR } from './shims.js';
import { dtsCandidates, LIB_DIR, packageRequestUrl, TYPES_DIR, type TypeStore } from './typeStore.js';

/**
 * A synchronous TypeScript CompilerHost over the project's VFS and a filled
 * {@link TypeStore}. Module resolution is done here rather than by TypeScript's
 * node resolver: project imports follow the runtime's own rules (resolve.ts
 * probing, tsconfig aliases), bare imports go to the types the CDN named, and
 * references inside fetched declaration files resolve as URLs.
 */
export interface VirtualHostOptions {
  fs: VirtualFileSystem;
  store: TypeStore;
  typesOrigin: string;
  dependencies: Readonly<Record<string, string>>;
  aliases: readonly PathAlias[];
  /** The ambient shim's text (see shims.ts). */
  shim: string;
}

const TS_PROBE = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function extensionOf(ts: typeof TS, path: string): TS.Extension {
  if (path.endsWith('.d.ts')) return ts.Extension.Dts;
  if (path.endsWith('.d.mts')) return ts.Extension.Dmts;
  if (path.endsWith('.d.cts')) return ts.Extension.Dcts;
  const map: Record<string, TS.Extension> = {
    '.ts': ts.Extension.Ts, '.tsx': ts.Extension.Tsx, '.mts': ts.Extension.Mts, '.cts': ts.Extension.Cts,
    '.js': ts.Extension.Js, '.jsx': ts.Extension.Jsx, '.mjs': ts.Extension.Mjs, '.cjs': ts.Extension.Cjs, '.json': ts.Extension.Json,
  };
  return map[extname(path)] ?? ts.Extension.Ts;
}

/** TypeScript's probing for a project-relative path: extensions, `.js` → `.ts`, `index`. */
function probeProject(fs: VirtualFileSystem, base: string): string | undefined {
  const ext = extname(base);
  if (fs.isFile(base) && TS_PROBE.includes(ext)) return base;
  for (const candidate of TS_PROBE) if (fs.isFile(base + candidate)) return base + candidate;
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    const stem = base.slice(0, -ext.length);
    for (const alt of ['.ts', '.tsx', '.d.ts', '.mts', '.cts']) if (fs.isFile(stem + alt)) return stem + alt;
  }
  for (const candidate of TS_PROBE) if (fs.isFile(join(base, `index${candidate}`))) return join(base, `index${candidate}`);
  return undefined;
}

export function createVirtualHost(ts: typeof TS, options: VirtualHostOptions): TS.CompilerHost {
  const { fs, store } = options;

  const readFile = (path: string): string | undefined => {
    if (path === AMBIENT_SHIM_PATH) return options.shim;
    if (path === EMPTY_TYPES_PATH) return 'export {};\n';
    return fs.readText(path) ?? store.read(path);
  };

  function typesFor(url: string | undefined | null): string | undefined {
    return url ? store.virtualPath(url) : undefined;
  }

  function resolveInTypes(specifier: string, containingUrl: string): string | undefined {
    if (isBareSpecifier(specifier)) return typesFor(store.packages.get(packageRequestUrl(options.typesOrigin, specifier, {})));
    for (const candidate of dtsCandidates(specifier, containingUrl)) {
      const final = store.finalUrl(candidate);
      if (final) return typesFor(final);
    }
    return undefined;
  }

  function resolveInProject(specifier: string, containingFile: string): string | undefined {
    if (specifier.includes('?')) return undefined; // `?raw`/`?url`: the ambient shim declares them
    if (!isBareSpecifier(specifier)) {
      const base = specifier.startsWith('/') ? normalizePath(specifier) : join(dirname(containingFile), specifier);
      return probeProject(fs, base);
    }
    for (const alias of options.aliases) {
      const matches = alias.wildcard ? specifier.startsWith(alias.prefix) : specifier === alias.prefix;
      if (!matches) continue;
      const rest = alias.wildcard ? specifier.slice(alias.prefix.length) : '';
      for (const target of alias.targets) {
        const hit = probeProject(fs, normalizePath(target + rest));
        if (hit) return hit;
      }
    }
    return typesFor(store.packages.get(packageRequestUrl(options.typesOrigin, specifier, options.dependencies)));
  }

  function resolveModule(specifier: string, containingFile: string): TS.ResolvedModuleFull | undefined {
    const containingUrl = store.urlOf(containingFile);
    const resolved = containingUrl ? resolveInTypes(specifier, containingUrl) : resolveInProject(specifier, containingFile);
    if (!resolved) return undefined;
    return { resolvedFileName: resolved, extension: extensionOf(ts, resolved), isExternalLibraryImport: resolved.startsWith(`${TYPES_DIR}/`) };
  }

  /** `/// <reference types>` resolves the same from anywhere: acquisition keyed it by name. */
  function resolveTypeReference(name: string): string | undefined {
    if (SHIMMED_TYPE_REFERENCES.has(name)) return EMPTY_TYPES_PATH;
    return typesFor(store.packages.get(`types:${name}`));
  }

  return {
    getSourceFile(fileName, languageVersion) {
      const shared = !fs.isFile(fileName);
      const cached = shared ? store.sourceFiles.get(fileName) : undefined;
      if (cached) return cached;
      const text = readFile(fileName);
      if (text === undefined) return undefined;
      const file = ts.createSourceFile(fileName, text, languageVersion, true);
      // Lib and package files never change for a URL: parse once per store.
      if (shared && fileName !== AMBIENT_SHIM_PATH) store.sourceFiles.set(fileName, file);
      return file;
    },
    getDefaultLibFileName: (compilerOptions) => `${LIB_DIR}/${ts.getDefaultLibFileName(compilerOptions)}`,
    getDefaultLibLocation: () => LIB_DIR,
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile,
    directoryExists: (dir) => fs.isDirectory(dir) || dir.startsWith(TYPES_DIR) || dir === LIB_DIR || dir === SHIM_DIR,
    getDirectories: () => [],
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => ({ resolvedModule: resolveModule(literal.text, containingFile) })),
    resolveTypeReferenceDirectiveReferences: (references) =>
      references.map((reference) => {
        const resolved = resolveTypeReference(typeof reference === 'string' ? reference : reference.fileName);
        return {
          resolvedTypeReferenceDirective: resolved ? { primary: true, resolvedFileName: resolved, isExternalLibraryImport: true } : undefined,
        };
      }),
  };
}
