import type { VirtualFileSystem } from '../vfs.js';
import type { CompiledStyle, StyleCompilers } from './compilers.js';
import type { StyleImportHost } from './imports.js';
import { styleLanguageOf, styleLanguageOfLang } from './languages.js';

/** What turning a stylesheet into CSS needs; shared by the dev server and the build. */
export interface StylesheetContext {
  fs: VirtualFileSystem;
  dependencies: Readonly<Record<string, string>>;
  styles: StyleCompilers;
  imports: StyleImportHost;
}

/**
 * CSS for `source` written in `language`, read as the file `path` (its imports
 * resolve beside it). Plain CSS comes back unchanged.
 */
async function toCss(ctx: StylesheetContext, path: string, language: ReturnType<typeof styleLanguageOf>, source: string): Promise<CompiledStyle> {
  if (!language) throw new Error(`${path}: not a stylesheet`);
  if (language === 'css') return { css: source, loaded: [path] };
  const compiler = await ctx.styles(language, ctx.dependencies);
  try {
    return await compiler.compile(source, { path, language, imports: ctx.imports });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `${path}: ${message}`);
  }
}

/** A stylesheet file (`.css`, `.scss`, `.sass`, `.less`) as CSS, with every file it read. */
export function compileStylesheet(ctx: StylesheetContext, path: string, source = ctx.fs.readText(path) ?? ''): Promise<CompiledStyle> {
  return toCss(ctx, path, styleLanguageOf(path), source);
}

/**
 * A component's `<style lang="…">` block as CSS. The block belongs to `path` (the
 * component), so its imports resolve beside the component.
 */
export async function preprocessStyleBlock(ctx: StylesheetContext, lang: string | undefined, source: string, path: string): Promise<string> {
  const language = styleLanguageOfLang(lang);
  if (!language) throw new Error(`${path}: <style lang="${lang}"> is not a stylesheet language this runtime compiles.`);
  return (await toCss(ctx, path, language, source)).css;
}
