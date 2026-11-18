import type { CompileContext } from './compileScript.js';
import { compileModule } from './compileScript.js';
import { componentKindFor } from './components.js';
import { componentResources } from './componentResources.js';
import { injectStyleStatement, rewriteCssUrls } from './styleModules.js';
import { preprocessStyleBlock } from './styles/compile.js';

/**
 * A component source (`.vue`, `.svelte`, an Angular project's `.ts`) → one ES
 * module for the dev server: the compiled component, its imports mapped like any
 * script's, and its scoped CSS injected as a <style> tag keyed by the
 * component's path (an edit replaces it in place).
 */
export async function compileComponent(ctx: CompileContext, path: string): Promise<string> {
  const kind = componentKindFor(path, ctx.config.dependencies);
  if (!kind) throw new Error(`Not a component: ${path}`);
  const compiler = await ctx.components(kind, ctx.config.dependencies);
  const { styles } = ctx;
  const preprocessStyle = styles ? (lang: string, source: string) => preprocessStyleBlock(styles, lang, source, path) : undefined;
  const resources = componentResources({
    fs: ctx.fs,
    path,
    styles,
    track: ctx.track,
    // Inlined CSS lands in a <style> tag, so its relative url()s are re-rooted for the page.
    rewriteCss: (file, css) => rewriteCssUrls(ctx.fs, file, css, ctx.base),
  });
  const compiled = await compiler.compile(ctx.fs.readText(path) ?? '', { path, dev: true, preprocessStyle, ...resources });
  const js = await compileModule(ctx, path, compiled.code, compiled.loader, compiled.typescript);
  if (!compiled.css) return js;
  const css = rewriteCssUrls(ctx.fs, path, compiled.css, ctx.base);
  return `${js}\n${injectStyleStatement(path, JSON.stringify(css))}\n`;
}
