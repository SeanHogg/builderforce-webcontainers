/** Shared test wiring: the real compilers, as the browser runtime would load them. */
import * as esbuild from 'esbuild';
import * as compilerSfc from '@vue/compiler-sfc';
import * as svelteCompiler from 'svelte/compiler';
import { VirtualFileSystem } from '../src/vfs.js';
import { createVueCompiler } from '../src/vueCompiler.js';
import { createSvelteCompiler } from '../src/svelteCompiler.js';
import { staticComponentCompilers } from '../src/components.js';
import { createEsbuildBundler } from '../src/bundler.js';
import { createEsbuildTransformer } from '../src/transformer.js';

export const vue = createVueCompiler(compilerSfc);
export const svelte = createSvelteCompiler(svelteCompiler);
export const components = staticComponentCompilers({ '.vue': vue, '.svelte': svelte });
export const bundler = createEsbuildBundler(esbuild);
export const transformer = createEsbuildTransformer(esbuild);

export const text = (body: string | Uint8Array) => (typeof body === 'string' ? body : new TextDecoder().decode(body));

export function project(files: Record<string, string | Uint8Array>): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.mount(files);
  return fs;
}
