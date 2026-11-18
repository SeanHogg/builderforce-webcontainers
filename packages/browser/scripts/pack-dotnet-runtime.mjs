// Turn a built .NET runtime bundle (scripts/build-dotnet-runtime.mjs) into the npm package each release
// publishes (DOTNET_BUNDLE.npmPackage), at THIS package's exact version: the immutable, versioned source a
// host mirrors (`npm pack <npmPackage>@<version>`) to serve the bundle beside its preview and pass that URL
// as `dotnet.bundleUrl`. npm never accepts a version twice, so a version's bytes never change. Run from
// packages/browser after the build:
//
//   node scripts/pack-dotnet-runtime.mjs [--package <packages/browser dir>] [--out <bundle dir>]
//
// `--package` (default: this script's own packages/browser) names the checkout whose version is packed —
// the release builds an exact tag in a second checkout and packs it with this script; `--out` defaults to
// its dotnet-host/out.
//
// It refuses a bundle whose manifest is not the format the runtime reads, or whose files do not match the
// manifest's hashes (the loader would refuse them anyway — this fails the release instead of a user's
// run), then writes package.json and README.md beside manifest.json. `npm publish <out>` ships it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOTNET_BUNDLE } from '../src/runtimes/dotnet/dotnetBundle.ts';

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const packageDir = resolve(option('--package') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const out = resolve(packageDir, option('--out') ?? 'dotnet-host/out');
const browser = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));

const manifestPath = join(out, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error(`${manifestPath} does not exist: build the bundle first (pnpm build:dotnet).`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.format !== DOTNET_BUNDLE.format) throw new Error(`The bundle is manifest format ${manifest.format}; the runtime reads format ${DOTNET_BUNDLE.format}.`);

const files = Object.entries(manifest.files ?? {});
if (files.length === 0) throw new Error('The bundle manifest lists no files.');
for (const [path, sha256] of files) {
  if (isAbsolute(path) || path.split(/[\\/]/).some((segment) => segment === '..' || segment === '')) throw new Error(`The bundle manifest lists ${path}, which is not a plain relative path.`);
  const file = join(out, path);
  if (!existsSync(file)) throw new Error(`The bundle manifest lists ${path}, which is missing.`);
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== sha256) throw new Error(`${path} does not match the manifest's hash.`);
}

const pkg = {
  name: DOTNET_BUNDLE.npmPackage,
  version: browser.version,
  description: `The .NET runtime bundle (Mono browser-wasm, SDK ${manifest.sdkVersion}) for ${browser.name}@${browser.version}: serve this directory and pass its URL as \`dotnet.bundleUrl\`.`,
  keywords: ['dotnet', 'webassembly', 'browser-wasm', 'builderforce'],
  author: browser.author,
  license: browser.license,
  repository: { ...browser.repository, directory: 'packages/browser/dotnet-host' },
  homepage: browser.homepage,
  bugs: browser.bugs,
  files: ['manifest.json', '_framework', 'refs'],
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(join(out, 'README.md'), [
  `# ${pkg.name}`,
  '',
  `The .NET runtime bundle for \`${browser.name}@${browser.version}\` — built from the same tag by`,
  '`packages/browser/scripts/build-dotnet-runtime.mjs`. Not a library: a directory to serve.',
  '',
  `- .NET SDK ${manifest.sdkVersion}, runtime ${manifest.runtimeVersion}, target ${manifest.targetFramework}`,
  `- \`manifest.json\` (format ${manifest.format}) lists every file's SHA-256; the runtime refuses a file that does not match.`,
  '',
  'Serve this directory at the SAME version as the browser package — on the preview origin, since process',
  'Workers load scripts only from their own origin — and pass its URL:',
  '',
  '```ts',
  `startPreviewRuntime({ dotnet: { bundleUrl: 'https://<preview origin>/dotnet/${browser.version}/' } });`,
  '```',
  '',
  'It carries Mono and ASP.NET Core (MIT), Roslyn (MIT) and a patched Npgsql (PostgreSQL License), each under its own license.',
  '',
].join('\n'));
console.log(`Packed ${pkg.name}@${pkg.version} (${files.length} files) in ${out}`);
