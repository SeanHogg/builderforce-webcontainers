/**
 * What the launcher serves from this package's build: the preview origin's files
 * (`dist/assets.js` — the service worker, the relay page and the process Workers,
 * exactly what an embedder's preview host serves) and the launcher page
 * (`dist/launcher/{index.html,page.js,launcher.css}`).
 *
 * Found beside this module once built (`dist/launcher/server/` → `dist/`), or — run
 * from source, as the tests do — in the package's `dist/` (`src/launcher/server/` →
 * `../../../dist/`). `distDir` overrides both.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PreviewScript } from './previewHeaders.js';

export interface LauncherAssets {
  relayHtml: string;
  scripts: Readonly<Record<PreviewScript, string>>;
  /** The launcher page's files by name under `/launcher/` (`index.html`, `page.js`, `launcher.css`). */
  page: Readonly<Record<string, string>>;
}

/** The page's files and their content types. */
export const PAGE_FILES: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'page.js': 'text/javascript; charset=utf-8',
  'launcher.css': 'text/css; charset=utf-8',
};

interface AssetsModule {
  serviceWorkerSource: string;
  relayHtml: string;
  processWorkerSource: string;
  pythonWorkerSource: string;
  phpWorkerSource: string;
  dotnetWorkerSource: string;
  rustWorkerSource: string;
}

/** The package's `dist/` directory, or undefined when it has not been built. */
export function findDistDir(): string | undefined {
  const candidates = [new URL('../../', import.meta.url), new URL('../../../dist/', import.meta.url)].map((url) => fileURLToPath(url));
  return candidates.find((dir) => existsSync(join(dir, 'assets.js')) && existsSync(join(dir, 'launcher', 'page.js')));
}

/** Load every file the launcher serves. Throws, naming the build step, when the package is not built. */
export async function loadLauncherAssets(distDir: string | undefined = findDistDir()): Promise<LauncherAssets> {
  if (!distDir) throw new Error('The launcher needs the built package (dist/assets.js and dist/launcher/page.js): run `npm run build` in packages/browser.');
  const assets = (await import(pathToFileURL(join(distDir, 'assets.js')).href)) as AssetsModule;
  const page: Record<string, string> = {};
  for (const name of Object.keys(PAGE_FILES)) page[name] = await readFile(join(distDir, 'launcher', name), 'utf8');
  return {
    relayHtml: assets.relayHtml,
    scripts: {
      'sw.js': assets.serviceWorkerSource,
      'process-worker.js': assets.processWorkerSource,
      'python-worker.js': assets.pythonWorkerSource,
      'php-worker.js': assets.phpWorkerSource,
      'dotnet-worker.js': assets.dotnetWorkerSource,
      'rust-worker.js': assets.rustWorkerSource,
    },
    page,
  };
}
