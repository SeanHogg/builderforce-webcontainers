import type { FsChange, VirtualFileSystem } from './vfs.js';
import type { Transformer } from './transformer.js';
import type { PackageCdn, PackageCdnFactory } from './packageCdn.js';
import { esmShCdnFactory } from './packageCdn.js';
import { noComponentCompilers, type ComponentCompilers } from './components.js';
import { isConfigFile, readProjectConfig, type ProjectConfig } from './projectConfig.js';
import { detectProject, type ProjectProfile } from './detectProject.js';
import { compileScript, isScriptPath, moduleUrl, type ImportQuery } from './compileScript.js';
import { compileComponent } from './compileComponent.js';
import { transformHtml } from './html.js';
import { jsonToModule, rawToModule, urlToModule } from './styleModules.js';
import { packageStylesheetModule, previewCss, stylesheetModule, type DevStyleContext } from './devStyles.js';
import { loaderFor } from './transformer.js';
import { extname, join, normalizePath } from './paths.js';
import { JS_MIME, mimeFor } from './mime.js';
import { noStyleCompilers, type StyleCompilers } from './styles/compilers.js';
import { createStyleImportHost, type StyleImportHost, type StyleImportHostOptions } from './styles/imports.js';
import { isStylesheet } from './styles/languages.js';
import { packageStyleSpecifier } from './styles/packageStyles.js';
import { ModuleGraph } from './hot/moduleGraph.js';
import { planUpdate } from './hot/planUpdate.js';
import { componentNames, hookSignature, refreshFacts, refreshFooter, usesReactRefresh } from './hot/reactRefresh.js';
import type { PreviewUpdate } from './hot/client.js';

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
  cdn?: PackageCdnFactory;
  /** `.vue` / `.svelte` compilers. Without them, requesting a component is an error. */
  components?: ComponentCompilers;
  /** Sass / Less compilers. Without them, requesting a `.scss` or `.less` file is an error. */
  styles?: StyleCompilers;
  /** Where Sass/Less package imports are fetched from when not installed (default jsDelivr). */
  styleImports?: Pick<StyleImportHostOptions, 'fetchText' | 'packageFileUrl'>;
  /** The "Built with Builderforce.ai" badge in served pages. Default true. */
  attribution?: boolean;
  /** Host scripts (JavaScript source) run in every preview page before the app. */
  previewScripts?: readonly string[];
  /** The runtime's nonce, put in the bridge of every served page (the host accepts preview messages only with it). */
  previewNonce?: string;
  /**
   * Hot updates: stylesheets swap and React components re-render in place on an
   * edit, keeping state (see {@link DevServer.planUpdate}). Default true.
   */
  hot?: boolean;
}

const NO_STORE = { 'cache-control': 'no-store' };
const CSS_MIME = mimeFor('.css');

/**
 * Documents opt into COEP so the preview can be framed by a cross-origin-isolated
 * host (one running WebGPU, WASM threads or WebContainers): an isolated page
 * refuses any nested document that does not. `credentialless` is harmless when the
 * host is not isolated — package modules are CORS fetches anyway, and cross-origin
 * images still load, just without cookies. CORP `cross-origin` lets such a host
 * frame the preview when it is served from a separate origin (relay mode).
 */
const DOCUMENT_HEADERS = {
  'cross-origin-embedder-policy': 'credentialless',
  'cross-origin-resource-policy': 'cross-origin',
};

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

/** Adding or removing a file, or touching config or HTML, can change how OTHER files resolve. */
function isStructuralChange(change: FsChange): boolean {
  return change.type !== 'write' || change.created === true || isConfigFile(change.path) || extname(change.path) === '.html';
}

/**
 * The dev server: request path in, response out. It does not listen on anything —
 * the host decides how requests arrive (a service worker in the browser, a plain
 * function call in tests), which is what keeps it runtime-agnostic.
 *
 * Responses are cached per (file, query) and validated against the file's VFS
 * version. Editing a file evicts it and everything that read it; creating or
 * deleting a file, or touching a config file, clears everything.
 *
 * While serving, it records what the preview loaded and what imports what (the
 * {@link ModuleGraph}); {@link planUpdate} turns an edit into a hot update from it.
 */
export class DevServer {
  private config?: ProjectConfig;
  private cdn?: Promise<PackageCdn>;
  private styleImports?: StyleImportHost;
  private profileCache?: ProjectProfile;
  private readonly cache = new Map<string, { version: number; file: ServedFile }>();
  private readonly graph = new ModuleGraph();
  private readonly unwatch: () => void;
  private readonly hot: boolean;
  private previewScripts: readonly string[];

  constructor(private readonly options: DevServerOptions) {
    if (!options.base.endsWith('/')) throw new Error('DevServer base must end with "/"');
    this.previewScripts = options.previewScripts ?? [];
    this.hot = options.hot !== false;
    this.unwatch = options.fs.watch((change) => this.onChange(change));
  }

  dispose(): void {
    this.unwatch();
    this.cache.clear();
    this.graph.clear();
  }

  /** Replace the host scripts injected into preview pages; takes effect on the next page load. */
  setPreviewScripts(scripts: readonly string[]): void {
    this.previewScripts = [...scripts];
    for (const key of [...this.cache.keys()]) if (/\.html?\?/.test(key)) this.cache.delete(key);
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

    const specifier = packageStyleSpecifier(path);
    if (specifier !== undefined) return this.cached(path, `${path}?`, 0, () => this.producePackageStyle(specifier));

    const publicPath = join(profile.publicDir, path);
    const file = fs.isFile(path) ? path : fs.isFile(publicPath) ? publicPath : undefined;
    if (!file) {
      // An extension-less path is a client-side route: serve the app (SPA fallback).
      if (!extname(path) && !query) return this.serveDocument(profile);
      return query || isScriptPath(path) ? errorModule(`Cannot find module ${path}`) : reply(404, 'text/plain; charset=utf-8', `Not found: ${path}`);
    }
    return this.cached(file, `${file}?${query ?? ''}`, fs.version(file) ?? 0, () => this.produce(file, query));
  }

  /**
   * What open previews should do about `changes` (one burst of edits): swap
   * stylesheets and re-render React components in place, or reload. Undefined
   * when nothing the preview loaded changed. Bumps the stamps of re-run modules,
   * so call it once per burst and send the result.
   */
  planUpdate(changes: readonly FsChange[]): PreviewUpdate | undefined {
    if (!changes.length) return undefined;
    if (!this.hot || changes.some(isStructuralChange)) return { type: 'reload' };
    const plan = planUpdate({
      changed: [...new Set(changes.map((change) => change.path))],
      graph: this.graph,
      refresh: this.refreshEnabled(),
      hooksChanged: (path) => this.hooksChanged(path),
    });
    if (plan.reload) return { type: 'reload' };
    if (!plan.styles.length && !plan.boundaries.length) return undefined;

    const stamp = this.graph.bump(plan.touched);
    // Their importers' compiled output names the old stamps.
    for (const path of plan.touched) {
      this.evict(path);
      for (const importer of this.graph.importers(path)) this.evict(importer);
    }
    const { base } = this.options;
    return {
      type: 'update',
      styles: plan.styles.map((path) => ({ path: base + path.slice(1), url: moduleUrl(base, path, undefined, stamp), stamp })),
      modules: plan.boundaries.map((path) => moduleUrl(base, path, undefined, stamp)),
    };
  }

  private async cached(file: string, key: string, version: number, produce: () => Promise<ServedFile>): Promise<ServedFile> {
    this.graph.markServed(file);
    const hit = this.cache.get(key);
    if (hit && hit.version === version) return hit.file;
    const served = await produce();
    this.cache.set(key, { version, file: served });
    return served;
  }

  private evict(file: string): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith(file + '?')) this.cache.delete(key);
  }

  private async produce(file: string, query: ImportQuery | undefined): Promise<ServedFile> {
    const { fs, base } = this.options;
    const ext = extname(file);
    const dependencies = new Set<string>();
    try {
      if (query === 'raw') return reply(200, JS_MIME, rawToModule(fs.readText(file) ?? ''));
      if (query === 'url') return reply(200, JS_MIME, urlToModule(base + file.slice(1)));
      const ctx = await this.context(dependencies);
      if (isStylesheet(file)) {
        const style = query === 'import' ? await stylesheetModule(ctx, file) : await previewCss(ctx, file);
        for (const loaded of style.loaded) dependencies.add(loaded);
        return reply(200, query === 'import' ? JS_MIME : CSS_MIME, style.body);
      }
      if (ext === '.json' && query === 'import') return reply(200, JS_MIME, jsonToModule(fs.readText(file) ?? ''));
      if (loaderFor(ext)) return reply(200, JS_MIME, await this.compileWithRefresh(ctx, file));
      if (isScriptPath(file)) return reply(200, JS_MIME, await compileComponent(ctx, file));
      if (ext === '.html' || ext === '.htm') {
        return reply(200, mimeFor(ext), transformHtml(fs.readText(file) ?? '', { base, attribution: this.options.attribution, scripts: this.previewScripts, nonce: this.options.previewNonce }));
      }
      return reply(200, mimeFor(ext), fs.readFile(file) ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return query || isScriptPath(file) ? errorModule(`${file}: ${message}`) : reply(500, 'text/plain; charset=utf-8', message);
    } finally {
      this.graph.setDependencies(file, dependencies);
    }
  }

  private async producePackageStyle(specifier: string): Promise<ServedFile> {
    try {
      return reply(200, JS_MIME, (await packageStylesheetModule(await this.context(new Set()), specifier)).body);
    } catch (error) {
      return errorModule(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A script, with React Refresh registration appended when the preview runs it. */
  private async compileWithRefresh(ctx: DevStyleContext, file: string): Promise<string> {
    const code = await compileScript(ctx, file);
    if (!this.refreshEnabled()) return code;
    const names = componentNames(code);
    this.graph.setFacts(file, await refreshFacts(code, this.options.fs.readText(file) ?? '', names));
    return code + refreshFooter(file, names);
  }

  private hooksChanged(path: string): boolean {
    const facts = this.graph.factsOf(path);
    return !!facts && !!loaderFor(extname(path)) && hookSignature(this.options.fs.readText(path) ?? '') !== facts.hooks;
  }

  private projectConfig(): ProjectConfig {
    return (this.config ??= readProjectConfig(this.options.fs));
  }

  private refreshEnabled(): boolean {
    return this.hot && usesReactRefresh(this.projectConfig());
  }

  private async serveDocument(profile: ProjectProfile): Promise<ServedFile> {
    if (!profile.supported || !profile.htmlPath) {
      return reply(501, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><p>${profile.reason ?? 'Unsupported project.'}</p>`);
    }
    const html = this.options.fs.readText(profile.htmlPath) ?? '';
    const { base, attribution } = this.options;
    const refreshRuntime = this.refreshEnabled() ? (await this.packageCdn()).urlFor('react-refresh', '/runtime') : undefined;
    return reply(200, 'text/html; charset=utf-8', transformHtml(html, { base, entry: profile.entry, attribution, scripts: this.previewScripts, refreshRuntime, nonce: this.options.previewNonce }));
  }

  private packageCdn(): Promise<PackageCdn> {
    const config = this.projectConfig();
    return (this.cdn ??= Promise.resolve((this.options.cdn ?? esmShCdnFactory)(config.dependencies, { dev: true })));
  }

  /** The compile context for one response; `dependencies` collects the local files it reads. */
  private async context(dependencies: Set<string>): Promise<DevStyleContext> {
    const { fs, transformer, base } = this.options;
    const config = this.projectConfig();
    this.styleImports ??= createStyleImportHost({ fs, dependencies: config.dependencies, ...this.options.styleImports });
    return {
      fs,
      config,
      cdn: await this.packageCdn(),
      transformer,
      base,
      components: this.options.components ?? noComponentCompilers,
      styles: { fs, dependencies: config.dependencies, styles: this.options.styles ?? noStyleCompilers, imports: this.styleImports },
      track: (path) => dependencies.add(path),
      stampOf: (path) => this.graph.stampOf(path),
    };
  }

  private onChange(change: FsChange): void {
    if (!isStructuralChange(change)) {
      this.evict(change.path);
      for (const dependent of this.graph.dependents(change.path)) this.evict(dependent);
      return;
    }
    this.cache.clear();
    this.graph.clear();
    this.config = undefined;
    this.cdn = undefined;
    this.styleImports = undefined;
    this.profileCache = undefined;
  }
}
