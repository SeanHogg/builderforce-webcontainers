/**
 * The module system: Node's `Module` with `_load`, `_resolveFilename`,
 * `_extensions`, `_compile` and `require.cache` — the hooks tools monkeypatch
 * (module-alias, pirates, require-in-the-middle) are real and are what
 * `require` goes through.
 *
 * Every file runs inside the CommonJS wrapper; ES modules are rewritten to it
 * first (esm.ts). The wrapper also receives this process's globals (`process`,
 * `Buffer`, timers, `console`…) as parameters, so several runtimes can share
 * one JS realm (tests, the in-process kernel) without touching `globalThis`.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, extname } from '../paths.js';
import { esmToCjs, ESM_MARK, hasModuleSyntax, mayBeEsm } from './esm.js';
import { findPackageScope, IMPORT_CONDITIONS, nodeModulePaths, REQUIRE_CONDITIONS, resolveNodeModule, type Resolution } from './resolve.js';

export interface LoaderOptions {
  fs: VirtualFileSystem;
  isBuiltin(name: string): boolean;
  /** A builtin's exports (`fs`, `path`…). `module` is answered by the loader itself. */
  builtin(name: string): unknown;
  /** Injected into every module's wrapper by name. */
  globals: Record<string, unknown>;
}

export interface NodeModule {
  id: string;
  filename: string;
  path: string;
  exports: any;
  loaded: boolean;
  parent: NodeModule | null | undefined;
  children: NodeModule[];
  paths: string[];
  require(id: string): any;
  /** Top-level-await modules: settles when evaluation finishes. */
  __tla?: Promise<unknown>;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as FunctionConstructor;

function stripShebang(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  return text.startsWith('#!') ? '//' + text.slice(2) : text;
}

export function createModuleSystem(options: LoaderOptions) {
  const { fs } = options;
  const cache: Record<string, NodeModule> = Object.create(null);
  const interop = new WeakMap<object, object>();
  const globalNames = Object.keys(options.globals);
  const globalValues = globalNames.map((n) => options.globals[n]);
  let main: NodeModule | undefined;

  function isEsmFile(filename: string, source: string): boolean {
    const ext = extname(filename);
    if (ext === '.mjs') return true;
    if (ext === '.cjs') return false;
    if (findPackageScope(fs, dirname(filename))?.pkg.type === 'module') return true;
    // Node 22 "detect-module": ambiguous .js with import/export syntax is ESM.
    return mayBeEsm(source) && hasModuleSyntax(source);
  }

  /** What `import` sees of a module: an ES module's own namespace, or `{ default: module.exports, ...named }`. */
  function namespaceOf(exports: any): any {
    if (exports && exports[ESM_MARK]) return exports;
    if ((typeof exports !== 'object' && typeof exports !== 'function') || exports === null) return { default: exports };
    let ns = interop.get(exports);
    if (!ns) {
      ns = Object.create(null) as object;
      for (const key of Object.keys(exports)) if (key !== 'default') Object.defineProperty(ns, key, { enumerable: true, get: () => exports[key] });
      Object.defineProperty(ns, 'default', { enumerable: true, value: exports });
      interop.set(exports, ns);
    }
    return ns;
  }

  class Module implements NodeModule {
    static _cache = cache;
    static _pathCache = Object.create(null);
    static builtinModules: string[] = [];
    static globalPaths = ['/usr/local/lib/node'];
    static Module = Module;
    static _extensions: Record<string, (module: Module, filename: string) => void> = {
      '.js'(module, filename) {
        const source = fs.readText(filename) ?? '';
        if (isEsmFile(filename, source)) module._compile(esmToCjs(stripShebang(source)), filename, true);
        else module._compile(source, filename);
      },
      '.cjs'(module, filename) {
        module._compile(fs.readText(filename) ?? '', filename);
      },
      '.mjs'(module, filename) {
        module._compile(esmToCjs(stripShebang(fs.readText(filename) ?? '')), filename, true);
      },
      '.json'(module, filename) {
        try {
          module.exports = JSON.parse(stripShebang(fs.readText(filename) ?? ''));
        } catch (error) {
          (error as Error).message = `${filename}: ${(error as Error).message}`;
          throw error;
        }
      },
      '.node'(_module, filename) {
        throw Object.assign(new Error(`Native addons cannot run in the browser: ${filename}`), { code: 'ERR_DLOPEN_FAILED' });
      },
    };

    id: string;
    filename: string;
    path: string;
    exports: any = {};
    loaded = false;
    children: NodeModule[] = [];
    paths: string[];
    __tla?: Promise<unknown>;

    constructor(id = '', public parent: NodeModule | null | undefined = undefined) {
      this.id = id;
      this.filename = id;
      this.path = dirname(id || '/');
      this.paths = nodeModulePaths(this.path);
      parent?.children.push(this);
    }

    static _resolveFilename(request: string, parent?: NodeModule, _isMain?: boolean, opts?: { paths?: string[]; conditions?: readonly string[] }): string {
      const fromDir = parent?.filename ? dirname(parent.filename) : (options.globals.process as { cwd(): string } | undefined)?.cwd() ?? '/';
      const resolution = resolveNodeModule(fs, request, fromDir, {
        conditions: opts?.conditions ?? REQUIRE_CONDITIONS,
        isBuiltin: options.isBuiltin,
        from: parent?.filename,
        paths: opts?.paths,
      });
      return 'builtin' in resolution ? `node:${resolution.builtin}` : resolution.path;
    }

    static _load(request: string, parent?: NodeModule, isMain = false): any {
      const filename = Module._resolveFilename(request, parent, isMain);
      return loadResolved(filename, parent, isMain).exports;
    }

    static _nodeModulePaths = nodeModulePaths;
    static isBuiltin = (name: string) => options.isBuiltin(name.replace(/^node:/, ''));
    static createRequire = (filename: string | URL) => {
      const path = typeof filename === 'string' ? filename.replace(/^file:\/\//, '') : decodeURIComponent(filename.pathname);
      return makeRequire(new Module(path.endsWith('/') ? path + '__entry.js' : path));
    };
    static wrap = (source: string) => `(function (exports, require, module, __filename, __dirname) { ${source}\n});`;
    static wrapper = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'];
    static syncBuiltinESMExports = () => undefined;
    static register = () => undefined;
    static findSourceMap = () => undefined;
    static runMain = () => undefined;

    require(id: string): any {
      if (typeof id !== 'string' || !id) throw new TypeError('The "id" argument must be a non-empty string');
      return Module._load(id, this, false);
    }

    _compile(content: string, filename: string, esm = false): unknown {
      const require = makeRequire(this);
      const dir = dirname(filename);
      const names = ['exports', 'require', 'module', '__filename', '__dirname', ...globalNames];
      const values: unknown[] = [this.exports, require, this, filename, dir, ...globalValues];
      if (esm) {
        names.push('__bfwc_import', '__bfwc_dynamic', '__bfwc_meta', '__bfwc_esm', '__bfwc_star', '__bfwc_get');
        values.push(...esmHelpers(this, filename));
      }
      const code = `${stripShebang(content)}\n//# sourceURL=${encodeURI('file://' + filename)}`;
      let fn: (...args: unknown[]) => unknown;
      try {
        fn = new Function(...names, code) as typeof fn;
      } catch (error) {
        if (esm && error instanceof SyntaxError && /await/.test(error.message)) fn = new AsyncFunction(...names, code) as typeof fn;
        else {
          if (error instanceof Error) error.message = `${filename}: ${error.message}`;
          throw error;
        }
      }
      const result = fn.apply(this.exports, values);
      if (result instanceof Promise) this.__tla = result;
      return result;
    }
  }

  function esmHelpers(module: Module, filename: string): unknown[] {
    const load = (specifier: string): { exports: any; __tla?: Promise<unknown> } => {
      let target: string;
      try {
        target = Module._resolveFilename(specifier, module, false, { conditions: REQUIRE_CONDITIONS });
      } catch (error) {
        // Prefer a package's CommonJS build (no transform, no binding snapshots);
        // ESM-only packages resolve through the "import" condition instead.
        if ((error as { code?: string }).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
        target = Module._resolveFilename(specifier, module, false, { conditions: IMPORT_CONDITIONS });
      }
      return loadResolved(target, module, false);
    };
    const importSync = (specifier: string) => namespaceOf(load(specifier).exports);
    const meta = {
      url: 'file://' + filename,
      filename,
      dirname: dirname(filename),
      resolve: (specifier: string) => {
        const target = Module._resolveFilename(specifier, module, false, { conditions: IMPORT_CONDITIONS });
        return target.startsWith('node:') ? target : 'file://' + target;
      },
    };
    const define = (exports: any, getters: Record<string, () => unknown>) => {
      Object.defineProperty(exports, '__esModule', { value: true });
      Object.defineProperty(exports, ESM_MARK, { value: true });
      for (const [name, get] of Object.entries(getters)) Object.defineProperty(exports, name, { enumerable: true, configurable: true, get });
    };
    const star = (exports: any, ns: any) => {
      for (const key of Object.keys(ns)) {
        if (key === 'default' || key === '__esModule' || Object.prototype.hasOwnProperty.call(exports, key)) continue;
        Object.defineProperty(exports, key, { enumerable: true, configurable: true, get: () => ns[key] });
      }
    };
    const get = (ns: any, key: string) => {
      try {
        return ns[key];
      } catch {
        return undefined; // a cyclic import read before the binding was initialised
      }
    };
    const dynamic = async (specifier: string) => {
      const loaded = load(String(specifier));
      if (loaded.__tla) await loaded.__tla;
      return namespaceOf(loaded.exports);
    };
    return [importSync, dynamic, meta, define, star, get];
  }

  function loadResolved(filename: string, parent: NodeModule | undefined, isMain: boolean): { exports: any } {
    if (filename.startsWith('node:')) {
      const name = filename.slice(5);
      return { exports: name === 'module' ? Module : options.builtin(name) };
    }
    const cached = cache[filename];
    if (cached) {
      if (parent && !parent.children.includes(cached)) parent.children.push(cached);
      return cached;
    }
    const module = new Module(filename, parent ?? null);
    if (isMain) {
      main = module;
      module.id = '.';
    }
    cache[filename] = module;
    try {
      const handler = Module._extensions[extname(filename)] ?? Module._extensions['.js']!;
      handler(module, filename);
    } catch (error) {
      delete cache[filename];
      throw error;
    }
    module.loaded = true;
    return module;
  }

  function makeRequire(module: Module) {
    const require = ((id: string) => module.require(id)) as ((id: string) => any) & Record<string, any>;
    const resolve = (request: string, opts?: { paths?: string[] }) => {
      const target = Module._resolveFilename(request, module, false, opts);
      return target.startsWith('node:') && !request.startsWith('node:') ? request : target;
    };
    resolve.paths = (request: string) => (options.isBuiltin(request) ? null : nodeModulePaths(module.path));
    require.resolve = resolve;
    require.cache = cache;
    require.extensions = Module._extensions;
    Object.defineProperty(require, 'main', { get: () => main, enumerable: true });
    return require;
  }

  return {
    Module,
    cache,
    /** Run `filename` as the main module. */
    runMain(filename: string): NodeModule {
      return loadResolved(filename, undefined, true) as NodeModule;
    },
    get main() {
      return main;
    },
    createRequire: Module.createRequire,
    resolve(request: string, fromDir: string): Resolution {
      return resolveNodeModule(fs, request, fromDir, { conditions: REQUIRE_CONDITIONS, isBuiltin: options.isBuiltin });
    },
  };
}

export type ModuleSystem = ReturnType<typeof createModuleSystem>;
