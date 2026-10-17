import {
  createLessCompiler,
  createSassCompiler,
  type LessLike,
  type SassLike,
  type StyleCompiler,
  type StyleCompilers,
} from '@seanhogg/builderforce-webcontainers-core';
import { memoizedLoader, nativeImport, rangeOf, type ImportModule } from './cdnModules.js';

/**
 * Sass and Less, fetched from a CDN the first time a project has a `.scss`,
 * `.sass` or `.less` file (or a `<style lang>` block), pinned to the project's own
 * range. Both official packages ship pure-JS builds that run in a page.
 */
export interface CdnStyleCompilerOptions {
  /** The ES module URL of `sass` for a range. */
  sassUrl?: (range: string) => string;
  /** The ES module URL of `less` for a range. */
  lessUrl?: (range: string) => string;
  /** Loads a module by URL. Default: native `import()`. */
  importModule?: ImportModule;
}

export const defaultSassUrl = (range: string) => `https://esm.sh/sass@${range}`;
export const defaultLessUrl = (range: string) => `https://esm.sh/less@${range}`;

/** A CommonJS build arrives as the default export; an ES build as the namespace. */
const moduleApi = <T>(module: unknown, probe: string): T => {
  const namespace = module as Record<string, unknown>;
  return (probe in namespace ? namespace : namespace.default) as T;
};

export function createCdnStyleCompilers(options: CdnStyleCompilerOptions = {}): StyleCompilers {
  const load = memoizedLoader<StyleCompiler>(options.importModule ?? nativeImport);
  return (language, dependencies) => {
    if (language === 'less') {
      const url = (options.lessUrl ?? defaultLessUrl)(rangeOf(dependencies, 'less', '4'));
      return load(url, (module) => createLessCompiler(moduleApi<LessLike>(module, 'render')));
    }
    const range = rangeOf(dependencies, 'sass', rangeOf(dependencies, 'sass-embedded', '1'));
    const url = (options.sassUrl ?? defaultSassUrl)(range);
    return load(url, (module) => createSassCompiler(moduleApi<SassLike>(module, 'compileStringAsync')));
  };
}
