import type { StyleImportHost } from './imports.js';
import type { StyleLanguage } from './languages.js';

/**
 * CSS preprocessors (Sass, Less) as a PORT, like the Transformer and the
 * component compilers: the core never imports one. The browser runtime loads the
 * official pure-JS builds from a CDN the first time a project needs one; Node
 * tests pass the npm packages in. Every `@use` / `@import` goes through a
 * {@link StyleImportHost}, so a compiler never touches a real file system.
 */
export type PreprocessedLanguage = Exclude<StyleLanguage, 'css'>;

export interface StyleCompileRequest {
  /** The stylesheet's id (a VFS path) — its imports resolve against it. */
  path: string;
  language: PreprocessedLanguage;
  imports: StyleImportHost;
}

export interface CompiledStyle {
  css: string;
  /** Every file the compile read, by id, the entry included — what an edit to must recompile. */
  loaded: string[];
}

export interface StyleCompiler {
  compile(source: string, request: StyleCompileRequest): Promise<CompiledStyle>;
}

/** Supplies the compiler for a language, given the project's ranges to pick a matching version. */
export type StyleCompilers = (language: PreprocessedLanguage, dependencies: Readonly<Record<string, string>>) => Promise<StyleCompiler>;

/** Compilers already in hand (tests, a host that bundles them). Sass serves `.scss` and `.sass`. */
export function staticStyleCompilers(compilers: { sass?: StyleCompiler; less?: StyleCompiler }): StyleCompilers {
  return (language) => {
    const compiler = language === 'less' ? compilers.less : compilers.sass;
    return compiler ? Promise.resolve(compiler) : Promise.reject(new Error(`No compiler for .${language} files is configured.`));
  };
}

export const noStyleCompilers: StyleCompilers = staticStyleCompilers({});

// ---- Sass -------------------------------------------------------------------

type SassSyntax = 'scss' | 'indented' | 'css';

interface SassImporter {
  canonicalize(url: string, context: { fromImport: boolean; containingUrl?: URL | null }): Promise<URL | null>;
  load(canonicalUrl: URL): Promise<{ contents: string; syntax: SassSyntax } | null>;
}

/** The subset of the `sass` package's API (its browser and Node builds share it) the adapter uses. */
export interface SassLike {
  compileStringAsync(
    source: string,
    options: { syntax: SassSyntax; url: URL; importer: SassImporter; importers: SassImporter[]; style: 'expanded' },
  ): Promise<{ css: string; loadedUrls: URL[] }>;
}

/** Project and installed files live under this scheme, so Sass resolves their relative imports itself. */
const VFS_SCHEME = 'bfwc:';
const toSassUrl = (id: string) => new URL(/^https?:/i.test(id) ? id : `${VFS_SCHEME}${id}`);
const fromSassUrl = (url: URL) => (url.protocol === VFS_SCHEME ? decodeURI(url.pathname) : url.href);

/** Partials, extensions and index files, in Sass's own order. */
export function sassCandidates(path: string): string[] {
  const slash = path.lastIndexOf('/') + 1;
  const dir = path.slice(0, slash);
  const base = path.slice(slash);
  if (/\.(s[ac]ss|css)$/i.test(base)) return [path, `${dir}_${base}`];
  return [
    `${path}.scss`, `${dir}_${base}.scss`, `${path}.sass`, `${dir}_${base}.sass`, `${path}.css`,
    `${path}/_index.scss`, `${path}/index.scss`, `${path}/_index.sass`, `${path}/index.sass`,
  ];
}

const sassSyntax = (language: StyleLanguage): SassSyntax => (language === 'sass' ? 'indented' : language === 'css' ? 'css' : 'scss');

export function createSassCompiler(sass: SassLike): StyleCompiler {
  return {
    async compile(source, { path, language, imports }) {
      const importer: SassImporter = {
        async canonicalize(url, { containingUrl }) {
          const from = containingUrl ? fromSassUrl(containingUrl) : path;
          const absolute = url.startsWith(VFS_SCHEME) ? decodeURI(url.slice(VFS_SCHEME.length)) : url;
          const id = await imports.resolve(absolute, from, sassCandidates);
          return id ? toSassUrl(id) : null;
        },
        async load(canonicalUrl) {
          const file = await imports.load(fromSassUrl(canonicalUrl));
          return { contents: file.contents, syntax: sassSyntax(file.language) };
        },
      };
      const result = await sass.compileStringAsync(source, { syntax: sassSyntax(language), url: toSassUrl(path), importer, importers: [importer], style: 'expanded' });
      return { css: result.css, loaded: [path, ...result.loadedUrls.map(fromSassUrl).filter((id) => id !== path)] };
    },
  };
}

// ---- Less -------------------------------------------------------------------

interface LessLoadedFile {
  filename: string;
  contents: string;
}

/** The subset of the `less` package's API the adapter uses. */
export interface LessLike {
  render(input: string, options: { filename: string; plugins: unknown[]; javascriptEnabled: false }): Promise<{ css: string; imports: string[] }>;
  FileManager: new () => object;
}

export function lessCandidates(path: string): string[] {
  return /\.[a-z]+$/i.test(path.slice(path.lastIndexOf('/') + 1)) ? [path] : [`${path}.less`, path];
}

export function createLessCompiler(less: LessLike): StyleCompiler {
  return {
    async compile(source, { path, imports }) {
      // Less hands a file manager the importing file's DIRECTORY; resolution wants a
      // file in it, so name a placeholder beside the real files.
      const fromDirectory = (directory: string) => `${directory.endsWith('/') ? directory : `${directory}/`}__importer.less`;
      const Base = less.FileManager as new () => object;
      class ProjectFiles extends Base {
        supports() {
          return true;
        }
        supportsSync() {
          return false;
        }
        async loadFile(filename: string, currentDirectory: string): Promise<LessLoadedFile> {
          const id = await imports.resolve(filename, currentDirectory ? fromDirectory(currentDirectory) : path, lessCandidates);
          if (!id) throw Object.assign(new Error(`'${filename}' wasn't found`), { type: 'File' });
          const file = await imports.load(id);
          return { filename: file.id, contents: file.contents };
        }
      }
      const plugin = { install: (_less: unknown, manager: { addFileManager(manager: object): void }) => manager.addFileManager(new ProjectFiles()) };
      const result = await less.render(source, { filename: path, plugins: [plugin], javascriptEnabled: false });
      return { css: result.css, loaded: [path, ...result.imports.filter((id) => id !== path)] };
    },
  };
}
