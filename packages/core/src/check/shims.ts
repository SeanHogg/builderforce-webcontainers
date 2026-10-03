/**
 * Ambient declarations the checker adds, standing in for what a local install
 * would provide:
 *   • Vite's `vite/client` (`import.meta.env`, CSS/asset/`?raw` imports) and CRA's
 *     `react-scripts` types. Shimmed rather than fetched: they are what every
 *     generated app references, and a small local copy never fails to load;
 *   • `.vue` / `.svelte` imports. Component internals are not type-checked yet;
 *     importing one must not be an error;
 *   • packages whose types could not be found, declared as `any` — a CDN miss is
 *     not the user's type error.
 *
 * A pattern the project (or a fetched package) already declares is skipped: two
 * declarations of `*.vue` with a default export each would be an error of ours.
 */

export const SHIM_DIR = '/__bfwc_shims__';
export const AMBIENT_SHIM_PATH = `${SHIM_DIR}/ambient.d.ts`;
/** What a shimmed type reference (`/// <reference types="vite/client" />`) resolves to. */
export const EMPTY_TYPES_PATH = `${SHIM_DIR}/empty.d.ts`;
export const SHIMMED_TYPE_REFERENCES: ReadonlySet<string> = new Set(['vite/client', 'react-scripts']);

const STRING_DEFAULT = '{ const src: string; export default src; }';
const ANY_DEFAULT = '{ const value: any; export default value; }';

const MODULE_SHIMS: ReadonlyArray<[pattern: string, body: string]> = [
  ['*.module.css', '{ const classes: { readonly [key: string]: string }; export default classes; }'],
  ['*.module.scss', '{ const classes: { readonly [key: string]: string }; export default classes; }'],
  ['*.css', '{}'],
  ['*.scss', '{}'],
  ['*.sass', '{}'],
  ['*.less', '{}'],
  ...['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'mp3', 'wav', 'ogg', 'pdf', 'txt', 'md', 'wasm'].map(
    (ext): [string, string] => [`*.${ext}`, STRING_DEFAULT],
  ),
  ['*?raw', STRING_DEFAULT],
  ['*?url', STRING_DEFAULT],
  ['*?inline', STRING_DEFAULT],
  ['*.vue', ANY_DEFAULT],
  ['*.svelte', ANY_DEFAULT],
];

const IMPORT_META = `interface ImportMetaEnv {
  readonly [key: string]: any;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly SSR: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
  readonly hot?: any;
  readonly glob: any;
}`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when any of `texts` declares `declare module '<pattern>'`. */
export function declaresModule(texts: Iterable<string>, pattern: string): boolean {
  const re = new RegExp(`declare\\s+module\\s+['"]${escapeRegExp(pattern)}['"]`);
  for (const text of texts) if (re.test(text)) return true;
  return false;
}

export interface AmbientShimOptions {
  /** Declarations already loaded: the project's own `.d.ts` files and fetched package types. */
  existing: string[];
  /** Packages with no types found — declared as `any`. */
  untyped: string[];
}

export function ambientShim(options: AmbientShimOptions): string {
  const lines = [IMPORT_META];
  // CRA reads `process.env.REACT_APP_*`; @types/node, when loaded, declares it properly.
  if (!options.existing.some((text) => /declare\s+var\s+process\b/.test(text))) {
    lines.push('declare var process: { env: { readonly [key: string]: string | undefined; readonly NODE_ENV: string } };');
  }
  for (const [pattern, body] of MODULE_SHIMS) {
    if (!declaresModule(options.existing, pattern)) lines.push(`declare module ${JSON.stringify(pattern)} ${body}`);
  }
  for (const name of options.untyped) {
    lines.push(`declare module ${JSON.stringify(name)};`);
    lines.push(`declare module ${JSON.stringify(`${name}/*`)};`);
  }
  return lines.join('\n') + '\n';
}
