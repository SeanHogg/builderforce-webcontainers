/**
 * The .NET runtime bundle for the launcher. `createDotnetProvider` needs
 * `dotnet.bundleUrl`; the release publishes the bundle as
 * `@seanhogg/builderforce-webcontainers-dotnet` (a directory holding `manifest.json`,
 * `_framework/` and `refs/`). The launcher serves it from `dotnetBundleDir`, else
 * from that package when it resolves (beside the project, then beside this package);
 * with neither, the page declines .NET services with the reason below.
 */
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The bundle's declaration imports nothing (scripts load it directly), so the Node-side launcher may import it.
import { DOTNET_BUNDLE } from '../../runtimes/dotnet/dotnetBundle.js';
import { isInside } from './projectFiles.js';

/** The bundle's npm package: spelled once, in `DOTNET_BUNDLE.npmPackage`. */
export const DOTNET_BUNDLE_PACKAGE = DOTNET_BUNDLE.npmPackage;

export type DotnetBundleSource = { dir: string } | { dir: null; reason: string };

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.dll': 'application/octet-stream',
  '.pdb': 'application/octet-stream',
  '.dat': 'application/octet-stream',
  '.blat': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

function resolvePackageDir(from: string): string | undefined {
  try {
    return dirname(createRequire(join(from, 'noop.js')).resolve(`${DOTNET_BUNDLE_PACKAGE}/package.json`));
  } catch {
    return undefined;
  }
}

/** Where the bundle is: `explicit`, else the package beside `projectDir`, else beside this module. */
export function resolveDotnetBundle(projectDir: string, explicit?: string): DotnetBundleSource {
  if (explicit) {
    return existsSync(join(explicit, 'manifest.json'))
      ? { dir: explicit }
      : { dir: null, reason: `dotnetBundleDir (${explicit}) holds no manifest.json.` };
  }
  const here = fileURLToPath(new URL('.', import.meta.url));
  for (const from of [projectDir, here]) {
    const dir = resolvePackageDir(from);
    if (dir && existsSync(join(dir, 'manifest.json'))) return { dir };
  }
  return { dir: null, reason: `${DOTNET_BUNDLE_PACKAGE} is not installed (install it, or pass dotnetBundleDir).` };
}

/** A file of the bundle at `relativePath` (`_framework/dotnet.js`); null when it is missing or outside the bundle. */
export async function readDotnetBundleFile(dir: string, relativePath: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (!relativePath || relativePath.split('/').some((segment) => segment === '..' || segment === '' || segment.includes('\\'))) return null;
  let root: string;
  let real: string;
  try {
    root = await realpath(dir);
    real = await realpath(join(root, ...relativePath.split('/')));
  } catch {
    return null;
  }
  if (!isInside(root, real) || !(await stat(real)).isFile()) return null;
  return { body: await readFile(real), contentType: CONTENT_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream' };
}
