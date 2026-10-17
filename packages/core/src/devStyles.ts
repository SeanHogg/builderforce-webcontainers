import type { CompileContext } from './compileScript.js';
import { mapSpecifier } from './compileScript.js';
import { dirname } from './paths.js';
import { resolvePackage } from './resolve.js';
import { cssToModule, injectStyleStatement, rewriteCssImports, rewriteCssUrls } from './styleModules.js';
import { compileStylesheet, type StylesheetContext } from './styles/compile.js';
import { cssModuleToModule, scopeCssModule } from './styles/cssModules.js';
import { lessCandidates, sassCandidates } from './styles/compilers.js';
import { isCssModule, styleLanguageOf } from './styles/languages.js';
import { linkStylesheetModule } from './styles/packageStyles.js';

/**
 * How the dev server serves stylesheets: compiled (Sass/Less), with `url()`s and
 * `@import`s pointed where the preview can load them, as CSS (a `<link>`) or as
 * the JS module an import from code becomes — a <style> tag, plus the scoped
 * class map for a CSS Module.
 */
export interface DevStyleContext extends CompileContext {
  styles: StylesheetContext;
}

export interface PreviewStyle {
  body: string;
  /** VFS files read, the stylesheet's partials included — the hot-update graph's edges. */
  loaded: string[];
}

const isUrl = (id: string) => /^https?:/i.test(id);

async function previewCssOf(ctx: DevStyleContext, path: string, source?: string): Promise<PreviewStyle> {
  const compiled = await compileStylesheet(ctx.styles, path, source);
  const packageUrl = (specifier: string) => {
    const { name, subpath } = resolvePackage(ctx.config.packageAliases, specifier);
    return ctx.cdn.urlFor(name, subpath);
  };
  const css = rewriteCssImports(ctx.fs, path, rewriteCssUrls(ctx.fs, path, compiled.css, ctx.base), ctx.base, packageUrl);
  return { body: css, loaded: compiled.loaded.filter((id) => !isUrl(id)) };
}

/** A stylesheet requested as CSS (a `<link>`, a CSS `@import`). */
export function previewCss(ctx: DevStyleContext, path: string): Promise<PreviewStyle> {
  return previewCssOf(ctx, path);
}

/** A stylesheet imported from JS: a module injecting it, exporting the class map for a CSS Module. */
export async function stylesheetModule(ctx: DevStyleContext, path: string): Promise<PreviewStyle> {
  const { body: css, loaded } = await previewCssOf(ctx, path);
  if (!isCssModule(path)) return { body: cssToModule(path, css), loaded };
  const scoped = scopeCssModule(css, path);
  const body = cssModuleToModule(scoped, path, (expression) => injectStyleStatement(path, expression), (from) => mapSpecifier(ctx, dirname(path), from));
  return { body, loaded };
}

/**
 * `import 'bootstrap/dist/css/bootstrap.css'`: a plain package stylesheet is
 * linked from the package CDN; a Sass/Less one (`bootstrap/scss/bootstrap.scss`)
 * is found the way its own imports are (installed, else the CDN) and compiled.
 */
export async function packageStylesheetModule(ctx: DevStyleContext, specifier: string): Promise<PreviewStyle> {
  const { name, subpath } = resolvePackage(ctx.config.packageAliases, specifier);
  const language = styleLanguageOf(subpath);
  if (language === 'css') return { body: linkStylesheetModule(specifier, ctx.cdn.urlFor(name, subpath)), loaded: [] };
  const id = await ctx.styles.imports.resolve(`~${name}${subpath}`, undefined, language === 'less' ? lessCandidates : sassCandidates);
  if (!id) throw new Error(`Cannot find the stylesheet ${specifier}`);
  const file = await ctx.styles.imports.load(id);
  const compiled = await compileStylesheet(ctx.styles, id, file.contents);
  // In a <style> tag a relative `url()` would resolve against the page; anchor it to the file.
  const css = isUrl(id) ? compiled.css.replace(/url\(\s*(['"]?)(?!data:|https?:|\/|#)([^'")]+)\1\s*\)/g, (_m, quote: string, ref: string) => `url(${quote}${new URL(ref, id).href}${quote})`) : rewriteCssUrls(ctx.fs, id, compiled.css, ctx.base);
  return { body: cssToModule(`/${specifier}`, css), loaded: compiled.loaded.filter((loaded) => !isUrl(loaded)) };
}
