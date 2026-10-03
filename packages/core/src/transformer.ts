/**
 * The compiler, as a PORT. The core never imports esbuild: the browser runtime
 * plugs in esbuild-wasm, tests plug in native esbuild, and a fork can plug in SWC
 * or anything else that turns TS/JSX into an ES module.
 */
export type Loader = 'js' | 'jsx' | 'ts' | 'tsx';

export interface TransformRequest {
  loader: Loader;
  /** The VFS path — shows up in error messages and source maps. */
  sourcefile: string;
  /** Compile-time replacements, esbuild `define` semantics (values are JS source). */
  define: Record<string, string>;
  jsx: { runtime: 'automatic' | 'classic'; importSource: string };
}

export interface Transformer {
  transform(code: string, request: TransformRequest): Promise<{ code: string }>;
}

/** The subset of esbuild's (and esbuild-wasm's) API the adapter uses. */
export interface EsbuildLike {
  transform(
    code: string,
    options: {
      loader: Loader;
      sourcefile: string;
      format: 'esm';
      target: string;
      define: Record<string, string>;
      jsx: 'automatic' | 'transform';
      jsxImportSource?: string;
      sourcemap: 'inline';
    },
  ): Promise<{ code: string }>;
}

/** Adapt esbuild or esbuild-wasm to {@link Transformer}. */
export function createEsbuildTransformer(esbuild: EsbuildLike): Transformer {
  return {
    transform(code, request) {
      return esbuild.transform(code, {
        loader: request.loader,
        sourcefile: request.sourcefile,
        format: 'esm',
        target: 'es2020',
        define: request.define,
        jsx: request.jsx.runtime === 'automatic' ? 'automatic' : 'transform',
        ...(request.jsx.runtime === 'automatic' ? { jsxImportSource: request.jsx.importSource } : {}),
        sourcemap: 'inline',
      });
    },
  };
}

/** The loader for a source extension, or undefined when the file is not compiled. */
export function loaderFor(ext: string): Loader | undefined {
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    // `.js` gets the JSX loader: Create React App puts JSX in `.js` files, and the
    // JSX loader accepts plain JavaScript unchanged.
    case '.js':
    case '.jsx':
      return 'jsx';
    case '.mjs':
    case '.cjs':
      return 'js';
    default:
      return undefined;
  }
}
