// Build the .NET runtime bundle (PRD 31 §W9 phase 6c) — a URL artifact the host serves and passes as
// the .NET process Worker's `dotnet.bundleUrl`; never part of the npm package. Needs the .NET 10 SDK
// (with its ASP.NET Core shared framework) and git. Run from packages/browser:
//
//   node scripts/build-dotnet-runtime.mjs [--out dotnet-host/out] [--work dotnet-host/.work]
//
// 1. Npgsql (DOTNET_BUNDLE.packages.npgsql) is cloned at its tag, patched for browser-wasm
//    (dotnet-host/patches/npgsql-browser.patch) and built.
// 2. The host program (dotnet-host/) is built for browser-wasm with it: Mono, the host, ASP.NET Core,
//    Roslyn and Npgsql land in <out>/_framework (dotnet.js is the entry).
// 3. Reference assemblies for in-browser builds are packed, one file per group, into <out>/refs/<group>.bin:
//    `netcore` (Microsoft.NETCore.App.Ref), `aspnetcore` (Microsoft.AspNetCore.App.Ref, only the assemblies
//    the bundle can run), and one group per bundled package.
// 4. <out>/manifest.json describes it all for runtimes/dotnet/dotnetLoader.ts.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOTNET_BUNDLE } from '../src/runtimes/dotnet/dotnetBundle.ts';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = join(packageDir, 'dotnet-host');
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return resolve(packageDir, at >= 0 ? process.argv[at + 1] : fallback);
};
const out = option('--out', 'dotnet-host/out');
const work = option('--work', 'dotnet-host/.work');

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const read = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', ...options }).trim();

const sdkVersion = read('dotnet', ['--version']);
if (Number(sdkVersion.split('.')[0]) < 10) throw new Error(`The .NET 10 SDK is required (dotnet --version: ${sdkVersion}).`);
const properties = JSON.parse(
  read('dotnet', ['msbuild', join(hostDir, 'BfwcDotnetHost.csproj'), '-getProperty:BundledNETCoreAppPackageVersion', '-getProperty:NetCoreTargetingPackRoot', '-p:NpgsqlDll=unused'], { cwd: hostDir }),
).Properties;
const runtimeVersion = properties.BundledNETCoreAppPackageVersion;
const packsRoot = properties.NetCoreTargetingPackRoot;
mkdirSync(work, { recursive: true });

// 1. The patched Npgsql.
const npgsql = DOTNET_BUNDLE.packages.npgsql;
const npgsqlDir = join(work, `npgsql-${npgsql.version}`);
if (!existsSync(npgsqlDir)) {
  run('git', ['-c', 'core.autocrlf=false', 'clone', '--quiet', '--depth', '1', '--branch', npgsql.tag, npgsql.repository, npgsqlDir]);
  run('git', ['apply', '--whitespace=nowarn', join(hostDir, 'patches', 'npgsql-browser.patch')], { cwd: npgsqlDir });
}
// The source generator's build-only dependency (Scriban) has advisories; nothing of it ships.
run('dotnet', ['build', 'src/Npgsql/Npgsql.csproj', '-c', 'Release', '-f', 'net8.0', '-p:DeveloperBuild=True', '-p:NuGetAudit=false', '-nologo', '-v:q'], { cwd: npgsqlDir });
const npgsqlDll = join(npgsqlDir, 'src', 'Npgsql', 'bin', 'Release', 'net8.0', 'Npgsql.dll');

// 2. The host program for browser-wasm.
const hostOut = join(work, 'host');
rmSync(hostOut, { recursive: true, force: true });
run('dotnet', ['build', 'BfwcDotnetHost.csproj', '-c', 'Release', '-nologo', '-v:q', `-p:NpgsqlDll=${npgsqlDll}`, '-o', hostOut], { cwd: hostDir });
const framework = join(hostOut, 'wwwroot', '_framework');
if (!existsSync(join(framework, 'dotnet.js'))) throw new Error(`No dotnet.js in ${framework}: the browser-wasm build did not produce a bundle.`);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'refs'), { recursive: true });
// Precompressed copies are left out: the server hosting the bundle compresses as it likes.
cpSync(framework, join(out, '_framework'), { recursive: true, filter: (source) => !/\.(gz|br)$/.test(source) });
const runnable = new Set(readdirSync(join(out, '_framework')).filter((file) => file.endsWith('.dll')));

// 3. Reference assemblies, one pack per group.
const refDir = (pack) => {
  const versions = readdirSync(join(packsRoot, pack)).filter((version) => version.startsWith('10.'));
  const version = versions.includes(runtimeVersion) ? runtimeVersion : versions.sort().at(-1);
  if (!version) throw new Error(`No ${pack} 10.x under ${packsRoot}.`);
  return join(packsRoot, pack, version, 'ref', DOTNET_BUNDLE.targetFramework);
};
const dllsIn = (dir) => readdirSync(dir).filter((file) => file.endsWith('.dll')).map((file) => join(dir, file));
const references = {};
const pack = (group, files) => {
  const entries = [];
  const chunks = [];
  let offset = 0;
  for (const file of files.sort()) {
    const bytes = readFileSync(file);
    entries.push({ name: basename(file), offset, length: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;
  }
  writeFileSync(join(out, 'refs', `${group}.bin`), Buffer.concat(chunks));
  references[group] = { pack: `refs/${group}.bin`, files: entries };
};
pack('netcore', dllsIn(refDir('Microsoft.NETCore.App.Ref')));
pack('aspnetcore', dllsIn(refDir('Microsoft.AspNetCore.App.Ref')).filter((file) => runnable.has(basename(file))));
pack('npgsql', [npgsqlDll]);

// 4. The manifest.
const manifest = {
  format: DOTNET_BUNDLE.format,
  sdkVersion,
  runtimeVersion,
  targetFramework: DOTNET_BUNDLE.targetFramework,
  entry: '_framework/dotnet.js',
  assembly: DOTNET_BUNDLE.hostAssembly,
  references,
  packages: {
    npgsql: { name: npgsql.name, version: npgsql.version, references: ['npgsql/Npgsql.dll', 'aspnetcore/Microsoft.Extensions.Logging.Abstractions.dll'] },
  },
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const size = (dir) => readdirSync(dir).reduce((total, file) => total + (statSync(join(dir, file)).isDirectory() ? size(join(dir, file)) : statSync(join(dir, file)).size), 0);
console.log(`.NET runtime bundle (SDK ${sdkVersion}, runtime ${runtimeVersion}) in ${out}: ${(size(out) / 1048576).toFixed(1)} MiB`);
