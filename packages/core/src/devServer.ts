import type { FsChange, VirtualFileSystem } from './vfs.js';
import type { Transformer } from './transformer.js';
import type { PackageCdn } from './packageCdn.js';
import { createEsmShCdn } from './packageCdn.js';
import { isConfigFile, readProjectConfig, type ProjectConfig } from './projectConfig.js';
import { detectProject, type ProjectProfile } from './detectProject.js';
import { compileScript, type CompileContext, type ImportQuery } from './compileScript.js';
import { transformHtml } from './html.js';
import { cssToModule, jsonToModule, rawToModule, rewriteCssUrls, urlToModule } from './styleModules.js';
import { loaderFor } from './transformer.js';
import { extname, join, normalizePath } from './paths.js';
import { JS_MIME, mimeFor } from './mime.js';

export interface ServedFile {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export interface DevServerOptions {
  fs: VirtualFileSystem;
  transformer: Transformer;
  /** The URL the preview is served under, ending in `/` (`/__bfwc/<id>/`). */
  base: string;
  /** Package CDN factory, given the project's dependency ranges. Default: esm.sh. */
  cdn?: (dependencies: Record<string, string>) => PackageCdn;
  /** The "Built with Builderforce.ai" badge in served pages. Default true. */
  attribution?: boolean;
}

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * Documents opt into COEP so the preview can be framed by a cross-origin-isolated
 * host (one running WebGPU, WASM threads or WebContainers): an isolated page
 * refuses any nested document that does not. `credentialless` is harmless when the
 * host is not isolated — package modules are CORS fetches anyway, and cross-origin
 * images still load, just without cookies.
 */
const DOCUMENT_HEADERS = { 'cross-origin-embedder-policy': 'credentialless' };

function reply(status: number, contentType: string, body: string | Uint8Array): ServedFile {
  const document = contentType.startsWith('text/html') ? DOCUMENT_HEADERS : undefined;
  return { status, headers: { 'content-type': contentType, ...NO_STORE, ...document }, body };
}

/** A module that throws — evaluated in the preview, it reaches the error bridge. */
function errorModule(message: string): ServedFile {
  return reply(200, JS_MIME, `throw new Error(${JSON.stringify(message)});`);
}

function parseQuery(search: string): ImportQuery | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.has('raw')) return 'raw';
  if (params.has('url')) return 'url';
  if (params.has('import')) return 'import';
  return undefined;
}

/**
 * The dev server: request path in, response out. It does not listen on anything —
 * the host decides how requests arrive (a service worker in the browser, a plain
 * function call in tests), which is what keeps it runtime-agnostic.
 *
 * Responses are cached per (file, query) and validated against the file's VFS
 * version. Edits to an existing file evict only that file; creating or deleting a
 * file, or touching a config file, clears everything, since either can change how
 * OTHER files' imports resolve.
 */
export class DevServer {
  private config?: ProjectConfig;
  private cdn?: PackageCdn;
  private profileCache?: ProjectProfile;
  private readonly cache = new Map<string, { version: number; file: ServedFile }>();
  private readonly unwatch: () => void;

  constructor(private readonly options: DevServerOptions) {
    if (!options.base.endsWith('/')) throw new Error('DevServer base must end with "/"');
    this.unwatch = options.fs.watch((change) => this.onChange(change));
  }

  dispose(): void {
    this.unwatch();
    this.cache.clear();
  }

  profile(): ProjectProfile {
    return (this.profileCache ??= detectProject(this.options.fs));
  }

  async handle(requestPath: string, search = ''): Promise<ServedFile> {
    const { fs } = this.options;
    const path = normalizePath(decodeURIComponent(requestPath));
    const query = parseQuery(search);
    const profile = this.profile();

    if (path === '/' || path === '/index.html' || path === profile.htmlPath) return this.serveDocument(profile);

    const publicPath = join(profile.publicDir, path);
    const file = fs.isFile(path) ? path : fs.isFile(publicPath) ? publicPath : undefined;
    if (!file) {
      // An extension-less path is a client-side route: serve the app (SPA fallback).
      if (!extname(path) && !query) return this.serveDocument(profile);
      return query || loaderFor(extname(path)) ? errorModule(`Cannot find module ${path}`) : reply(404, 'text/plain; charset=utf-8', `Not found: ${path}`);
    }

    const key = `${file}?${query ?? ''}`;
    const version = fs.version(file) ?? 0;
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit.file;

    const served = await this.produce(file, query);
    this.cache.set(key, { version, file: served });
    return served;
  }

  private async produce(file: string, query: ImportQuery | undefined): Promise<ServedFile> {
    const { fs, base } = this.options;
    const ext = extname(file);
    try {
      if (query === 'raw') return reply(200, JS_MIME, rawToModule(fs.readText(file) ?? ''));
      if (query === 'url') return reply(200, JS_MIME, urlToModule(base + file.slice(1)));
      if (ext === '.css') {
        const css = rewriteCssUrls(fs, file, fs.readText(file) ?? '', base);
        return query === 'import' ? reply(200, JS_MIME, cssToModule(file, css)) : reply(200, mimeFor(ext), css);
      }
      if (ext === '.json' && query === 'import') return reply(200, JS_MIME, jsonToModule(fs.readText(file) ?? ''));
      if (loaderFor(ext)) return reply(200, JS_MIME, await compileScript(this.context(), file));
      if (ext === '.html' || ext === '.htm') {
        return reply(200, mimeFor(ext), transformHtml(fs.readText(file) ?? '', { base, attribution: this.options.attribution }));
      }
      return reply(200, mimeFor(ext), fs.readFile(file) ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return query || loaderFor(ext) ? errorModule(`${file}: ${message}`) : reply(500, 'text/plain; charset=utf-8', message);
    }
  }

  private serveDocument(profile: ProjectProfile): ServedFile {
    if (!profile.supported || !profile.htmlPath) {
      return reply(501, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><p>${profile.reason ?? 'Unsupported project.'}</p>`);
    }
    const html = this.options.fs.readText(profile.htmlPath) ?? '';
    const { base, attribution } = this.options;
    return reply(200, 'text/html; charset=utf-8', transformHtml(html, { base, entry: profile.entry, attribution }));
  }

  private context(): CompileContext {
    const { fs, transformer, base } = this.options;
    this.config ??= readProjectConfig(fs);
    this.cdn ??= (this.options.cdn ?? ((dependencies) => createEsmShCdn({ dependencies })))(this.config.dependencies);
    return { fs, config: this.config, cdn: this.cdn, transformer, base };
  }

  private onChange(change: FsChange): void {
    const structural = change.type === 'remove' || change.created === true || isConfigFile(change.path) || extname(change.path) === '.html';
    if (!structural) {
      for (const key of [...this.cache.keys()]) if (key.startsWith(change.path + '?')) this.cache.delete(key);
      return;
    }
    this.cache.clear();
    this.config = undefined;
    this.cdn = undefined;
    this.profileCache = undefined;
  }
}
