import type { VirtualFileSystem } from './vfs.js';
import type { ComponentRequest } from './components.js';
import { compileStylesheet, type StylesheetContext } from './styles/compile.js';
import { isStylesheet } from './styles/languages.js';
import { dirname, join } from './paths.js';

/**
 * The files a component references by path (Angular's `templateUrl`,
 * `styleUrl(s)`), read from the VFS relative to the component — the
 * `readResource` / `compileStylesheet` half of a {@link ComponentRequest},
 * shared by the dev server and the build. Every file read is reported to
 * `track`, so editing a template or stylesheet rebuilds the component.
 */
export interface ComponentResourceOptions {
  fs: VirtualFileSystem;
  /** The component's VFS path. */
  path: string;
  /** The project's stylesheet compilers; without them only plain `.css` can be read. */
  styles?: StylesheetContext;
  track?: (path: string) => void;
  /** A last pass over each compiled stylesheet (the dev server re-roots its `url()`s). */
  rewriteCss?: (file: string, css: string) => string;
}

export function componentResources(options: ComponentResourceOptions): Pick<ComponentRequest, 'readResource' | 'compileStylesheet'> {
  const { fs, path, styles, track } = options;
  const resolve = (file: string) => (file.startsWith('/') ? join(file) : join(dirname(path), file));

  const readResource = (file: string): string | undefined => {
    const resolved = resolve(file);
    track?.(resolved);
    return fs.readText(resolved);
  };

  const compile = styles
    ? async (file: string): Promise<string> => {
      const resolved = resolve(file);
      if (!isStylesheet(resolved)) throw new Error(`${path}: '${file}' is not a stylesheet.`);
      const compiled = await compileStylesheet(styles, resolved);
      track?.(resolved);
      for (const loaded of compiled.loaded) if (loaded.startsWith('/')) track?.(loaded);
      return options.rewriteCss ? options.rewriteCss(resolved, compiled.css) : compiled.css;
    }
    : undefined;

  return { readResource, ...(compile ? { compileStylesheet: compile } : {}) };
}
