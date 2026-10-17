import type { CompileContext } from './compileScript.js';
import { compileModule } from './compileScript.js';
import { componentExtension } from './components.js';
import { extname } from './paths.js';
import { injectStyleStatement, rewriteCssUrls } from './styleModules.js';
import { preprocessStyleBlock } from './styles/compile.js';

/**
 * A `.vue` / `.svelte` file → one ES module for the dev server: the compiled
 * component, its imports mapped like any script's, and its scoped CSS injected
 * as a <style> tag keyed by the component's path (an edit replaces it in place).
 */
export async function compileComponent(ctx: CompileContext, path: string): Promise<string> {
  const extension = componentExtension(extname(path));
  if (!extension) throw new Error(`Not a component: ${path}`);
  const compiler = await ctx.components(extension, ctx.config.dependencies);
  const { styles } = ctx;
  const preprocessStyle = styles ? (lang: string, source: string) => preprocessStyleBlock(styles, lang, source, path) : undefined;
  const compiled = await compiler.compile(ctx.fs.readText(path) ?? '', { path, dev: true, preprocessStyle });
  const js = await compileModule(ctx, path, compiled.code, compiled.loader);
  if (!compiled.css) return js;
  const css = rewriteCssUrls(ctx.fs, path, compiled.css, ctx.base);
  return `${js}\n${injectStyleStatement(path, JSON.stringify(css))}\n`;
}
