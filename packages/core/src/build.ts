import { VirtualFileSystem, type FileSystemTree, type FlatFiles } from './vfs.js';
import type { Bundler, BundleOutput } from './bundler.js';
import type { PackageCdnFactory } from './packageCdn.js';
import { esmShCdnFactory } from './packageCdn.js';
import { noComponentCompilers, type ComponentCompilers } from './components.js';
import { detectProject, type ProjectProfile } from './detectProject.js';
import { readProjectConfig } from './projectConfig.js';
import { buildDefine } from './compileScript.js';
import { createBuildHost } from './buildHost.js';
import { findHtmlEntries, rewriteBuiltHtml } from './buildHtml.js';

/**
 * `npm run build`, in the browser: the project in, a deployable static site out.
 *
 * The output needs no server and no node_modules — packages load from the CDN at
 * the same pinned, deduped URLs the dev server uses (production builds) — so it
 * can be uploaded as-is to any static host. Every file under `assets/` has a
 * content hash in its name and can be cached forever.
 */
export interface BuildOptions {
  /** The project: a file system, or files as `mount()` takes them. */
  files: VirtualFileSystem | FlatFiles | FileSystemTree;
  bundler: Bundler;
  /** Package CDN factory (called with `dev: false`). Default: esm.sh. */
  cdn?: PackageCdnFactory;
  /** `.vue` / `.svelte` compilers, needed when the project has components. */
  components?: ComponentCompilers;
  /**
   * Where the site will be served from. `./` (default) works from any directory;
   * an absolute base (`/app/`, `https://cdn.example.com/site/`) is used verbatim.
   */
  base?: string;
  /** Default true. */
  minify?: boolean;
}

export interface BuiltFile {
  /** Relative to the site root (`index.html`, `assets/main-1a2b3c4d.js`). */
  path: string;
  data: Uint8Array;
}

export interface BuildResult {
  files: BuiltFile[];
  profile: ProjectProfile;
}

const encoder = new TextEncoder();

function toFileSystem(files: BuildOptions['files']): VirtualFileSystem {
  if (files instanceof VirtualFileSystem) return files;
  const fs = new VirtualFileSystem();
  fs.mount(files);
  return fs;
}

/** `''`, `.` and `./` all mean relative; anything else gets its trailing slash. */
export function normalizeBase(base: string | undefined): string {
  if (!base || base === '.' || base === './') return './';
  return base.endsWith('/') ? base : `${base}/`;
}

function toBytes(contents: string | Uint8Array): Uint8Array {
  return typeof contents === 'string' ? encoder.encode(contents) : contents;
}

export async function buildProject(options: BuildOptions): Promise<BuildResult> {
  const fs = toFileSystem(options.files);
  const base = normalizeBase(options.base);
  const profile = detectProject(fs);
  if (!profile.supported || !profile.htmlPath) throw new Error(profile.reason ?? 'This project cannot be built here.');

  const config = readProjectConfig(fs, 'production');
  const cdn = await (options.cdn ?? esmShCdnFactory)(config.dependencies, { dev: false });
  const html = fs.readText(profile.htmlPath) ?? '';
  const entries = findHtmlEntries(fs, html, profile.htmlPath);
  // CRA pages carry no module script; the dev server injects the entry, so does the build.
  const inject = profile.entry && !entries.some((entry) => entry.tag === 'script') ? profile.entry : undefined;
  const entryPoints = [...new Set([...entries.map((entry) => entry.path), ...(inject ? [inject] : [])])];

  const host = createBuildHost({ fs, config, cdn, components: options.components ?? noComponentCompilers, publicDir: profile.publicDir, base });
  const bundled: BundleOutput = entryPoints.length
    ? await options.bundler.bundle({
      entryPoints,
      host,
      define: buildDefine(config, base, 'production'),
      jsx: config.jsx,
      minify: options.minify ?? true,
    })
    : { files: [], entries: {} };

  const out = new Map<string, Uint8Array>();
  // public/ first, so a generated file of the same name wins.
  const publicPrefix = `${profile.publicDir}/`;
  for (const path of fs.list()) {
    if (path.startsWith(publicPrefix) && path !== profile.htmlPath) out.set(path.slice(publicPrefix.length), toBytes(fs.readFile(path) ?? ''));
  }
  for (const [path, data] of host.assets) out.set(path, data);
  for (const file of bundled.files) out.set(file.path, file.contents);
  const page = rewriteBuiltHtml(html, { base, entries, outputs: bundled.entries, inject });
  out.set('index.html', encoder.encode(page));

  const files = [...out].map(([path, data]) => ({ path, data })).sort((a, b) => a.path.localeCompare(b.path));
  return { files, profile };
}
