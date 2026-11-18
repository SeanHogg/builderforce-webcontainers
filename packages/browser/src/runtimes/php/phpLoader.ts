/**
 * Loading PHP (php-wasm, from WordPress Playground) into a PHP process Worker:
 * a pinned php-wasm release from the jsDelivr npm CDN by default, or any
 * jsDelivr-compatible base a host serves it from (self-hosted, CSP). Two
 * modules load, lazily, once per Worker: `@php-wasm/universal` (the `PHP`
 * class, as an ES module bundle) and the PHP-version build's loader
 * (`@php-wasm/web-8-3/jspi/php_8_3.js`, which finds its `.wasm` beside itself);
 * the JSPI build where the engine has `WebAssembly.Suspending`, else Asyncify.
 *
 * php-wasm is GPL-2.0-or-later. This package never bundles it: it is fetched
 * at run time from where the host says, like Pyodide.
 *
 * The slice of the php-wasm API the runtime uses is typed here, so the
 * package's public types never depend on php-wasm.
 */
import type { WrappableEmscriptenFs } from '../emscripten/wrappedFsWrites.js';

/** The php-wasm release this runtime is built and tested against (`@php-wasm/*`). */
export const PHP_WASM_VERSION = '3.1.62';

/** The PHP version a process runs unless the host picks another. */
export const DEFAULT_PHP_VERSION = '8.3';

/** The PHP release each supported version is in php-wasm 3.1.62 (its build directories: `jspi/8_3_36/`). */
export const PHP_WASM_RELEASES: Readonly<Record<string, string>> = { '8.1': '8.1.34', '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27' };

/** PHP versions php-wasm builds that the runtime accepts. */
export const SUPPORTED_PHP_VERSIONS: readonly string[] = Object.keys(PHP_WASM_RELEASES);

/** Where php-wasm is loaded from unless a host overrides it: an npm CDN laid out as jsDelivr's (`<base>@scope/pkg@version/file`, `…/+esm`). */
export const DEFAULT_PHP_WASM_BASE_URL = 'https://cdn.jsdelivr.net/npm/';

/** A streamed PHP run: the CGI head (for requests), stdout and stderr as they are written, the exit code. */
export interface PhpStreamedResponse {
  readonly stdout: ReadableStream<ArrayBufferView | ArrayBuffer>;
  readonly stderr: ReadableStream<ArrayBufferView | ArrayBuffer>;
  readonly exitCode: Promise<number>;
  readonly headers: Promise<Record<string, string[]>>;
  readonly httpStatusCode: Promise<number>;
}

export interface PhpRunRequest {
  scriptPath?: string;
  code?: string;
  relativeUri?: string;
  protocol?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  env?: Record<string, string>;
  $_SERVER?: Record<string, string>;
}

/** The `PHP` instance calls the runtime makes. */
export interface PhpLike {
  /** Run PHP's CLI on `argv` (`['php', 'script.php', …]`, `['php', '-r', code]`). Once per instance. */
  cli(argv: string[], options?: { env?: Record<string, string> }): Promise<PhpStreamedResponse>;
  /** Run a script as a web request (CGI-style `$_SERVER`, `$_GET`, `$_POST`, cookies, body). */
  runStream(request: PhpRunRequest): Promise<PhpStreamedResponse>;
  /** Run code or a script to completion, buffered. */
  run(request: PhpRunRequest): Promise<{ readonly text: string; readonly errors: string; readonly exitCode: number }>;
  setSapiName(name: string): unknown;
  chdir(path: string): void;
}

/** A WebSocket constructor, as Emscripten's socket layer makes them (`new Ctor(url, protocols)`). */
export type WebSocketConstructorLike = new (url: string, protocols?: string | string[]) => object;

/** php-wasm's Emscripten module: its file system, and the socket layer's config (read at each `connect`). */
export interface PhpModuleLike {
  readonly FS: WrappableEmscriptenFs;
  websocket?: {
    url?: string | ((socket: unknown, addr: string, port: number) => string);
    subprotocol?: string | null;
    decorator?: (base: WebSocketConstructorLike) => WebSocketConstructorLike;
    [key: string]: unknown;
  };
}

/** A started PHP: the instance and its module. */
export interface LoadedPhp {
  php: PhpLike;
  module: PhpModuleLike;
}

export interface PhpLoadOptions {
  /** Where php-wasm is served. Default {@link DEFAULT_PHP_WASM_BASE_URL}. */
  baseUrl?: string;
  /** Default {@link DEFAULT_PHP_VERSION}. */
  phpVersion?: string;
}

interface UniversalModule {
  PHP: new (runtimeId: number) => PhpLike;
  loadPHPRuntime(loader: unknown, options: Record<string, unknown>): Promise<number>;
  __private__dont__use: symbol;
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

/** The PHP version as the host asked, refused unless php-wasm builds it. */
export function checkPhpVersion(version: string | undefined): string {
  const chosen = version ?? DEFAULT_PHP_VERSION;
  if (!SUPPORTED_PHP_VERSIONS.includes(chosen)) throw new Error(`PHP ${chosen} is not available in the browser runtime (php-wasm ${PHP_WASM_VERSION} builds ${SUPPORTED_PHP_VERSIONS.join(', ')}).`);
  return chosen;
}

/** The two module URLs for `version` under `baseUrl` (exported for hosts that mirror them). */
export function phpWasmModuleUrls(baseUrl: string, version: string, mode: 'jspi' | 'asyncify'): { universal: string; loader: string } {
  const base = withSlash(baseUrl);
  return {
    universal: `${base}@php-wasm/universal@${PHP_WASM_VERSION}/+esm`,
    loader: `${base}@php-wasm/web-${version.replace('.', '-')}@${PHP_WASM_VERSION}/${mode}/php_${version.replace('.', '_')}.js`,
  };
}

/** The modules, fetched once per Worker (a Worker runs one process, so one base and version). */
let modules: { key: string; load: Promise<[UniversalModule, unknown]> } | undefined;

/** Start a PHP. Each call is a fresh instance; the modules are fetched once per base and version. */
export async function loadPhpRuntime(options: PhpLoadOptions = {}): Promise<LoadedPhp> {
  const version = checkPhpVersion(options.phpVersion);
  const mode = 'Suspending' in WebAssembly ? 'jspi' : 'asyncify';
  const urls = phpWasmModuleUrls(options.baseUrl ?? DEFAULT_PHP_WASM_BASE_URL, version, mode);
  const key = `${urls.universal} ${urls.loader}`;
  if (modules?.key !== key) {
    const load = Promise.all([import(/* @vite-ignore */ urls.universal) as Promise<UniversalModule>, import(/* @vite-ignore */ urls.loader)]);
    modules = { key, load };
    load.catch(() => {
      if (modules?.load === load) modules = undefined; // a failed fetch may be retried
    });
  }
  const [universal, loader] = await modules.load;
  // php-wasm's scheduler expects it; Workers lack it (php-wasm's own web loader does the same).
  const scope = globalThis as { setImmediate?: (callback: () => void) => unknown };
  scope.setImmediate ??= (callback) => setTimeout(callback, 0);
  // The socket layer's config object exists from the start; the process points it at the runtime's network (phpSockets.ts).
  const runtime = await universal.loadPHPRuntime(loader, { phpWasmAsyncMode: mode, websocket: {} });
  const php = new universal.PHP(runtime);
  return { php, module: (php as unknown as Record<symbol, PhpModuleLike>)[universal.__private__dont__use]! };
}
