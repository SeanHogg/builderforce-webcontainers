/**
 * Loading Pyodide (CPython on WebAssembly) into a Python process Worker: a
 * pinned version from the jsDelivr CDN by default, or any `indexURL` a host
 * serves it from (self-hosted, CSP). The loader script is fetched once per
 * Worker (lazy, cached); the browser's HTTP cache keeps the Wasm,
 * the standard library and wheels across processes.
 *
 * The slice of the Pyodide API the runtime uses is typed here, so the package's
 * public types never depend on the `pyodide` package.
 */

/** The Pyodide release this runtime is built and tested against. */
export const PYODIDE_VERSION = '314.0.7';

/** Where Pyodide is loaded from unless a host overrides it. */
export const DEFAULT_PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;


/** A Python object seen from JavaScript. */
export interface PyProxyLike {
  destroy?(): void;
  toJs?(options?: { dict_converter?: (entries: Iterable<[unknown, unknown]>) => unknown }): unknown;
  [key: string]: unknown;
}

/** The Emscripten file system calls the runtime makes. */
export interface EmscriptenFs {
  mkdirTree(path: string): void;
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  /** Like `stat`, without following a symlink. */
  lstat(path: string): { mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  unlink(path: string): void;
  rmdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
  cwd(): string;
  /** Wrapped to track truncation, which has no tracking hook. */
  truncate(path: string, length: number): void;
  ftruncate(fd: number, length: number): void;
  getStream(fd: number): { path?: string } | null | undefined;
  /** Emscripten's FS hooks: `onOpenFile`, `onWriteToFile`, `onCloseFile`, `onMakeDirectory`, `onMakeSymlink`, `onDeletePath`, `onMovePath`. */
  trackingDelegate: Record<string, ((...args: never[]) => void) | undefined>;
}

export interface PyodideLike {
  readonly FS: EmscriptenFs;
  readonly globals: PyProxyLike;
  runPython(code: string, options?: { globals?: PyProxyLike }): unknown;
  runPythonAsync(code: string, options?: { globals?: PyProxyLike }): Promise<unknown>;
  loadPackage(names: string | string[], options?: { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void }): Promise<unknown>;
  loadPackagesFromImports(code: string, options?: { messageCallback?: (message: string) => void; errorCallback?: (message: string) => void }): Promise<unknown>;
  pyimport(name: string): PyProxyLike;
  toPy(value: unknown): PyProxyLike;
  registerJsModule(name: string, module: object): void;
  setStdout(options: { write(buffer: Uint8Array): number; isatty?: boolean }): void;
  setStderr(options: { write(buffer: Uint8Array): number; isatty?: boolean }): void;
  setStdin(options: { stdin(): string | null | undefined; isatty?: boolean }): void;
}

export interface PyodideLoadOptions {
  /** Where `pyodide.js`/`pyodide.mjs`, the Wasm and the packages are served. Default {@link DEFAULT_PYODIDE_INDEX_URL}. */
  indexURL?: string;
  /** Environment for the interpreter (`os.environ` at start-up). */
  env?: Record<string, string>;
}

type LoadPyodide = (config: { indexURL: string; env?: Record<string, string>; stdout?: (line: string) => void; stderr?: (line: string) => void }) => Promise<PyodideLike>;

/** The loader script, fetched once: a Worker runs one process, so one `indexURL`. */
let loader: { indexURL: string; load: Promise<LoadPyodide> } | undefined;

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** `loadPyodide` from `indexURL`: the classic `pyodide.js` in a classic Worker, else the ES module. */
async function importLoader(indexURL: string): Promise<LoadPyodide> {
  const scope = globalThis as { loadPyodide?: LoadPyodide; importScripts?: (...urls: string[]) => void };
  if (typeof scope.importScripts === 'function') {
    try {
      scope.importScripts(`${indexURL}pyodide.js`);
      if (scope.loadPyodide) return scope.loadPyodide;
    } catch {
      // A module Worker cannot importScripts: fall through to import().
    }
  }
  const module = (await import(/* @vite-ignore */ `${indexURL}pyodide.mjs`)) as { loadPyodide: LoadPyodide };
  return module.loadPyodide;
}

/** Start an interpreter. The loader script is fetched once per `indexURL`; each call is a fresh interpreter. */
export async function loadPyodideRuntime(options: PyodideLoadOptions = {}): Promise<PyodideLike> {
  const indexURL = withSlash(options.indexURL ?? DEFAULT_PYODIDE_INDEX_URL);
  if (loader?.indexURL !== indexURL) {
    const load = importLoader(indexURL);
    loader = { indexURL, load };
    load.catch(() => {
      if (loader?.load === load) loader = undefined; // a failed fetch may be retried
    });
  }
  // Start-up chatter goes nowhere; the process installs its own stdout/stderr.
  const quiet = () => undefined;
  return (await loader.load)({ indexURL, env: options.env, stdout: quiet, stderr: quiet });
}
