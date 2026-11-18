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
  /** The project's TypeScript options, with any per-module override applied. */
  typescript?: TypeScriptOptions;
}

/**
 * The TypeScript compiler options that change emitted code, read from the
 * project's tsconfig (and overridden per module by a component compiler —
 * Angular needs legacy decorators).
 */
export interface TypeScriptOptions {
  experimentalDecorators?: boolean;
  useDefineForClassFields?: boolean;
  /** An esbuild target (`es2022`, `esnext`). */
  target?: string;
  /**
   * Downlevel `async`/`await` (and async iteration) to generators. zone.js cannot
   * patch native async functions, so the Angular CLI lowers them for zone apps.
   */
  lowerAsync?: boolean;
}

/** The output floor of the dev server's per-module transform and of a production bundle. */
export const TARGET_FLOOR = { transform: 'es2020', bundle: 'es2022' } as const;

/** `es2015` → 2015, `esnext` → Infinity; undefined for anything else. */
function targetYear(target: string): number | undefined {
  const lower = target.toLowerCase();
  if (lower === 'esnext') return Number.POSITIVE_INFINITY;
  const m = /^es(\d{4})$/.exec(lower);
  return m ? Number(m[1]) : undefined;
}

/**
 * The esbuild target for a tsconfig `target`, never below `floor`. A project's
 * own target is honoured only when it is at least the floor: the floors are what
 * this runtime always emitted, and a lower tsconfig target (CRA's `es5`, Vite's
 * `ES2017`/`ES2020`) would break code that worked before — top-level await in a
 * bundle, for one. One helper for the transformer and the bundler.
 */
export function targetAtLeast(target: string | undefined, floor: string): string {
  const year = target === undefined ? undefined : targetYear(target);
  return year !== undefined && year >= targetYear(floor)! ? target!.toLowerCase() : floor;
}

/** The esbuild options a {@link TypeScriptOptions} maps to (shared by the transformer and the bundler). */
export interface EsbuildTypeScriptOptions {
  tsconfigRaw?: { compilerOptions: { experimentalDecorators?: boolean; useDefineForClassFields?: boolean } };
  supported?: Record<string, boolean>;
}

export function esbuildTypeScriptOptions(typescript: TypeScriptOptions | undefined): EsbuildTypeScriptOptions {
  const out: EsbuildTypeScriptOptions = {};
  const compilerOptions: { experimentalDecorators?: boolean; useDefineForClassFields?: boolean } = {};
  if (typescript?.experimentalDecorators !== undefined) compilerOptions.experimentalDecorators = typescript.experimentalDecorators;
  if (typescript?.useDefineForClassFields !== undefined) compilerOptions.useDefineForClassFields = typescript.useDefineForClassFields;
  if (Object.keys(compilerOptions).length) out.tsconfigRaw = { compilerOptions };
  if (typescript?.lowerAsync) out.supported = { 'async-await': false, 'async-generator': false, 'for-await': false };
  return out;
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
    } & EsbuildTypeScriptOptions,
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
        target: targetAtLeast(request.typescript?.target, TARGET_FLOOR.transform),
        define: request.define,
        jsx: request.jsx.runtime === 'automatic' ? 'automatic' : 'transform',
        ...(request.jsx.runtime === 'automatic' ? { jsxImportSource: request.jsx.importSource } : {}),
        sourcemap: 'inline',
        ...esbuildTypeScriptOptions(request.typescript),
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
