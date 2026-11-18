import type { VirtualFileSystem } from '../vfs.js';
import type { StaticDir } from '../staticDirs.js';
import { PUBLIC_DIR } from '../staticDirs.js';
import { join, basename } from '../paths.js';
import { resolveLocal } from '../resolve.js';
import { readAngularWorkspace, type AngularAsset } from './workspace.js';

/**
 * How an Angular CLI project is served: its page, entry, static assets and the
 * modules imported ahead of the entry (polyfills, global styles, then
 * `@angular/compiler` — the JIT compiler must be loaded before any partially
 * compiled Angular package evaluates).
 */
export interface AngularProfile {
  htmlPath: string;
  entry: string;
  staticDirs: StaticDir[];
  preludes: string[];
}

const DEFAULT_INDEX = '/src/index.html';
const DEFAULT_MAIN = '/src/main.ts';

/** An Angular CLI project: `@angular/core` plus `angular.json` or `src/main.ts`. */
export function isAngularProject(fs: VirtualFileSystem, dependencies: ReadonlySet<string>): boolean {
  return dependencies.has('@angular/core') && (fs.isFile('/angular.json') || fs.isFile(DEFAULT_MAIN));
}

/** A string asset is copied to its path relative to the source root (`src/assets` → `/assets`). */
function assetDir(asset: AngularAsset, sourceRoot: string): StaticDir {
  const from = join('/', asset.input);
  if (asset.glob === undefined) {
    const root = join('/', sourceRoot);
    const to = from.startsWith(`${root}/`) ? from.slice(root.length) : `/${basename(from)}`;
    return { from, to };
  }
  // Only "everything under input" globs are honoured as such; any other glob
  // copies the whole input directory too.
  return { from, to: join('/', asset.output ?? '') };
}

/**
 * A `polyfills` or `styles` entry as a prelude specifier: a workspace file
 * becomes its absolute path; anything else names a package file
 * (`zone.js`, `@angular/material/prebuilt-themes/azure-blue.css`), spelled
 * bare — `node_modules/bootstrap/dist/css/bootstrap.min.css` included — so it
 * loads like any package import (a package stylesheet is linked from the CDN).
 */
function preludeSpecifier(fs: VirtualFileSystem, entry: string): string {
  return resolveLocal(fs, '/', join('/', entry)) ?? entry.replace(/^(?:\.\/)?node_modules\//, '');
}

export function angularProfile(fs: VirtualFileSystem, dependencies: ReadonlySet<string>): AngularProfile {
  const workspace = readAngularWorkspace(fs.readText('/angular.json') ?? '');
  if (!workspace) {
    return {
      htmlPath: DEFAULT_INDEX,
      entry: DEFAULT_MAIN,
      staticDirs: [...PUBLIC_DIR],
      preludes: [...(dependencies.has('zone.js') ? ['zone.js'] : []), '@angular/compiler'],
    };
  }
  return {
    htmlPath: workspace.index ? join('/', workspace.index) : DEFAULT_INDEX,
    entry: workspace.main ? join('/', workspace.main) : DEFAULT_MAIN,
    staticDirs: workspace.assets.map((asset) => assetDir(asset, workspace.sourceRoot)),
    preludes: [
      ...[...workspace.polyfills, ...workspace.styles].map((entry) => preludeSpecifier(fs, entry)),
      '@angular/compiler',
    ],
  };
}
