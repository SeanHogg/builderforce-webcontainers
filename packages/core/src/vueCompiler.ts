import type { ComponentCompiler } from './components.js';
import type { Loader } from './transformer.js';
import { contentHash } from './hash.js';

/**
 * Vue single-file components through `@vue/compiler-sfc` — the same steps
 * `@vitejs/plugin-vue` takes, minus HMR: script (with `<script setup>` and its
 * template inlined), a separate render function for options-API components, and
 * each `<style>` compiled with the component's scope id.
 */

interface VueBlock {
  content: string;
  lang?: string;
}

interface VueStyleBlock extends VueBlock {
  scoped?: boolean;
}

export interface VueDescriptor {
  script: VueBlock | null;
  scriptSetup: VueBlock | null;
  template: VueBlock | null;
  styles: VueStyleBlock[];
}

type Problem = string | { message: string };
/**
 * The script's binding analysis, passed from compileScript to compileTemplate
 * untouched. Opaque here (`any`) so the real compiler's precise type fits.
 */
type BindingMetadata = any;

/** The subset of `@vue/compiler-sfc` used (its browser build has the same API). */
export interface VueCompilerSfcLike {
  parse(source: string, options: { filename: string; sourceMap: boolean }): { descriptor: VueDescriptor; errors: Problem[] };
  compileScript(
    descriptor: VueDescriptor,
    options: { id: string; inlineTemplate: boolean; genDefaultAs: string; isProd: boolean; sourceMap: boolean },
  ): { content: string; bindings?: BindingMetadata };
  compileTemplate(options: {
    source: string;
    filename: string;
    id: string;
    scoped: boolean;
    isProd: boolean;
    compilerOptions: { bindingMetadata?: BindingMetadata; isTS?: boolean };
  }): { code: string; errors: Problem[] };
  compileStyle(options: { source: string; filename: string; id: string; scoped: boolean; isProd: boolean }): {
    code: string;
    errors: Problem[];
  };
}

const SCRIPT_LOADERS: Record<string, Loader> = { js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx' };

function fail(path: string, problems: Problem[]): never {
  const first = problems[0];
  throw new Error(`${path}: ${typeof first === 'string' ? first : first?.message ?? 'Vue compile error'}`);
}

export function createVueCompiler(sfc: VueCompilerSfcLike): ComponentCompiler {
  return {
    compile(source, { path, dev }) {
      const { descriptor, errors } = sfc.parse(source, { filename: path, sourceMap: false });
      if (errors.length) fail(path, errors);

      for (const style of descriptor.styles) {
        if (style.lang && style.lang !== 'css') {
          throw new Error(`${path}: <style lang="${style.lang}"> needs a CSS preprocessor this runtime does not have yet.`);
        }
      }

      // Stable per file, so the scope attribute does not change between reloads.
      const id = contentHash(path);
      const scoped = descriptor.styles.some((style) => style.scoped);
      const lang = descriptor.scriptSetup?.lang ?? descriptor.script?.lang ?? 'js';
      const loader = SCRIPT_LOADERS[lang];
      if (!loader) throw new Error(`${path}: <script lang="${lang}"> is not supported.`);

      const parts: string[] = [];
      let bindings: BindingMetadata;
      if (descriptor.script || descriptor.scriptSetup) {
        const script = sfc.compileScript(descriptor, { id, inlineTemplate: true, genDefaultAs: '_sfc_main', isProd: !dev, sourceMap: false });
        parts.push(script.content);
        bindings = script.bindings;
      } else {
        parts.push('const _sfc_main = {};');
      }

      // `<script setup>` inlines its template; anything else needs a render function.
      if (descriptor.template && !descriptor.scriptSetup) {
        const template = sfc.compileTemplate({
          source: descriptor.template.content,
          filename: path,
          id,
          scoped,
          isProd: !dev,
          compilerOptions: { bindingMetadata: bindings, isTS: loader === 'ts' || loader === 'tsx' },
        });
        if (template.errors.length) fail(path, template.errors);
        parts.push(template.code.replace(/\bexport (function|const) render\b/, '$1 _sfc_render'));
        parts.push('_sfc_main.render = _sfc_render;');
      }
      if (scoped) parts.push(`_sfc_main.__scopeId = ${JSON.stringify(`data-v-${id}`)};`);
      if (dev) parts.push(`_sfc_main.__file = ${JSON.stringify(path)};`);
      parts.push('export default _sfc_main;');

      const css = descriptor.styles
        .map((style) => {
          const out = sfc.compileStyle({ source: style.content, filename: path, id: `data-v-${id}`, scoped: !!style.scoped, isProd: !dev });
          if (out.errors.length) fail(path, out.errors);
          return out.code;
        })
        .join('\n');

      return { code: parts.join('\n'), loader, css };
    },
  };
}
