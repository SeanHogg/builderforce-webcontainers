import type { ComponentCompiler } from './components.js';

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

export function createSvelteCompiler(svelte: SvelteCompilerLike): ComponentCompiler {
  const major = Number.parseInt(svelte.VERSION, 10);
  // Svelte 5 renamed the browser target from 'dom' to 'client'.
  // Typed as Svelte 5's value; Svelte 4 receives its own spelling at runtime.
  const generate = (major >= 5 ? 'client' : 'dom') as 'client';
  return {
    compile(source, { path, dev }) {
      const result = svelte.compile(source, { filename: path, generate, css: 'external', dev });
      return { code: result.js.code, loader: 'js', css: result.css?.code ?? '' };
    },
  };
}
