/** Shared test wiring: the real compilers, as the browser runtime would load them. */
import * as esbuild from 'esbuild';
import * as compilerSfc from '@vue/compiler-sfc';
import * as svelteCompiler from 'svelte/compiler';
import * as sassModule from 'sass';
import lessModule from 'less';
import { VirtualFileSystem } from '../src/vfs.js';
import { createVueCompiler } from '../src/vueCompiler.js';
import { createSvelteCompiler } from '../src/svelteCompiler.js';
import { staticComponentCompilers } from '../src/components.js';
import { createEsbuildBundler } from '../src/bundler.js';
import { createEsbuildTransformer } from '../src/transformer.js';
import { createLessCompiler, createSassCompiler, staticStyleCompilers, type LessLike, type SassLike } from '../src/styles/compilers.js';

export const vue = createVueCompiler(compilerSfc);
export const svelte = createSvelteCompiler(svelteCompiler);
export const components = staticComponentCompilers({ '.vue': vue, '.svelte': svelte });
export const bundler = createEsbuildBundler(esbuild);
export const transformer = createEsbuildTransformer(esbuild);
export const styles = staticStyleCompilers({
  sass: createSassCompiler(sassModule as unknown as SassLike),
  less: createLessCompiler(lessModule as unknown as LessLike),
});

export const text = (body: string | Uint8Array) => (typeof body === 'string' ? body : new TextDecoder().decode(body));

export function project(files: Record<string, string | Uint8Array>): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.writeTree(files);
  return fs;
}
