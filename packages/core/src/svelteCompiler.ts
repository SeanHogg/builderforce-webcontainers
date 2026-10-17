import type { ComponentCompiler, ComponentRequest } from './components.js';

/**
 * Svelte components through `svelte/compiler`. CSS is always compiled as
 * `external` — Svelte scopes it with hashed class names — and handed back, so the
 * dev server and the build each place it their own way.
 *
 * Svelte 5 strips `<script lang="ts">` itself. Svelte 4 needs a preprocessor for
 * that, which this runtime does not run, so a TS component on Svelte 4 fails with
 * the compiler's own message.
 */
export interface SvelteCompilerLike {
  VERSION: string;
  compile(
    source: string,
    options: { filename: string; generate: 'client'; css: 'external'; dev: boolean },
  ): { js: { code: string }; css?: { code: string } | null };
}

const STYLE_BLOCK = /<style(\s[^>]*?)?\slang\s*=\s*["']?([\w-]+)["']?([^>]*)>([\s\S]*?)<\/style>/gi;

/** `<style lang="scss">` blocks compiled to plain `<style>` before Svelte sees them, as svelte-preprocess would. */
async function preprocessStyles(source: string, path: string, preprocessStyle: ComponentRequest['preprocessStyle']): Promise<string> {
  const blocks = [...source.matchAll(STYLE_BLOCK)].filter((match) => match[2] !== 'css');
  if (!blocks.length) return source;
  if (!preprocessStyle) throw new Error(`${path}: <style lang="${blocks[0]![2]}"> needs a CSS preprocessor, and none is configured.`);
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    const css = await preprocessStyle(block[2]!, block[4]!);
    out += `${source.slice(cursor, block.index)}<style${block[1] ?? ''}${block[3]}>${css}</style>`;
    cursor = block.index! + block[0].length;
  }
  return out + source.slice(cursor);
}

export function createSvelteCompiler(svelte: SvelteCompilerLike): ComponentCompiler {
  const major = Number.parseInt(svelte.VERSION, 10);
  // Svelte 5 renamed the browser target from 'dom' to 'client'.
  // Typed as Svelte 5's value; Svelte 4 receives its own spelling at runtime.
  const generate = (major >= 5 ? 'client' : 'dom') as 'client';
  return {
    async compile(source, { path, dev, preprocessStyle }) {
      const result = svelte.compile(await preprocessStyles(source, path, preprocessStyle), { filename: path, generate, css: 'external', dev });
      return { code: result.js.code, loader: 'js', css: result.css?.code ?? '' };
    },
  };
}
