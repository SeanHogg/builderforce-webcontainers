// Build the .NET runtime bundle (PRD 31 §W9 phase 6c) — a URL artifact the host serves and passes as
// the .NET process Worker's `dotnet.bundleUrl`; never part of the npm package. Needs the .NET SDK pinned by
// dotnet-host/global.json (with its ASP.NET Core shared framework) and git. Run from packages/browser:
//
//   node scripts/build-dotnet-runtime.mjs [--out dotnet-host/out] [--work dotnet-host/.work]
//
// `--out` and `--work` must be inside dotnet-host/ (both are emptied and rewritten).
//
// 1. Npgsql (DOTNET_BUNDLE.packages.npgsql) is fetched at its pinned commit (checked with `git rev-parse
//    HEAD`), patched for browser-wasm (dotnet-host/patches/npgsql-browser.patch) and built with the pinned
//    SDK. A cached clone is reused only when its marker names the same commit, patch and SDK pin.
// 2. The host program (dotnet-host/) is built for browser-wasm with it, its NuGet packages restored in locked
//    mode (dotnet-host/packages.lock.json): Mono, the host, ASP.NET Core, Roslyn and Npgsql land in
//    <out>/_framework (dotnet.js is the entry; it embeds Mono's boot config with every asset's SRI hash).
// 3. Reference assemblies for in-browser builds are packed, one file per group, into <out>/refs/<group>.bin:
//    `netcore` (Microsoft.NETCore.App.Ref), `aspnetcore` (Microsoft.AspNetCore.App.Ref, only the assemblies
//    the bundle can run), and one group per bundled package.
// 4. <out>/manifest.json describes it all for runtimes/dotnet/dotnetLoader.ts, with every file's SHA-256 and
//    each packed reference's, which the loader verifies before using them.
//
// To change the host's packages: edit BfwcDotnetHost.csproj, then `dotnet restore --force-evaluate
// -p:Configuration=Release` in dotnet-host/ to rewrite packages.lock.json (Release: the configuration built here).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOTNET_BUNDLE } from '../src/runtimes/dotnet/dotnetBundle.ts';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostDir = join(packageDir, 'dotnet-host');

/** A directory option, refused unless strictly inside dotnet-host/ — it is deleted and rewritten. */
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  const value = resolve(packageDir, at >= 0 ? process.argv[at + 1] : fallback);
  const inside = relative(hostDir, value);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${name} ${value} must be a directory inside ${hostDir} (it is emptied and rewritten).`);
  return value;
};
const out = option('--out', 'dotnet-host/out');
const work = option('--work', 'dotnet-host/.work');

// Quiet, telemetry-free CLI output (and parseable `-getProperty` JSON).
const env = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', env, ...options });
const read = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', env, ...options }).trim();
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Remove a directory a .NET build used: its build servers (MSBuild nodes, the compiler server) can still hold files open on Windows. */
const removeBuilt = (dir) => {
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    run('dotnet', ['build-server', 'shutdown'], { cwd: hostDir, stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
};

/** The JSON object in a command's output (anything the CLI prints around it — a banner, a notice — is ignored). */
const jsonIn = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`Expected JSON from dotnet msbuild -getProperty, got:\n${text}`);
  return JSON.parse(text.slice(start, end + 1));
};

// Every dotnet command runs where dotnet-host/global.json pins the SDK.
const globalJson = readFileSync(join(hostDir, 'global.json'), 'utf8');
const sdkVersion = read('dotnet', ['--version'], { cwd: hostDir });
if (Number(sdkVersion.split('.')[0]) < 10) throw new Error(`The .NET 10 SDK is required (dotnet --version: ${sdkVersion}).`);
const properties = jsonIn(
  read('dotnet', ['msbuild', join(hostDir, 'BfwcDotnetHost.csproj'), '-getProperty:BundledNETCoreAppPackageVersion', '-getProperty:NetCoreTargetingPackRoot', '-p:NpgsqlDll=unused'], { cwd: hostDir }),
).Properties;
const runtimeVersion = properties.BundledNETCoreAppPackageVersion;
const packsRoot = properties.NetCoreTargetingPackRoot;
mkdirSync(work, { recursive: true });

// 1. The patched Npgsql, at its pinned commit.
const npgsql = DOTNET_BUNDLE.packages.npgsql;
const patch = readFileSync(join(hostDir, 'patches', 'npgsql-browser.patch'));
const expectedMarker = JSON.stringify({ commit: npgsql.commit, patch: sha256(patch), globalJson: sha256(globalJson) });
// The clone's directory is named after what it is built from (commit, patch, SDK pin): another input is another
// directory, never a clean-up of a tree an editor's language server may hold open. Older clones are removed when they can be.
const npgsqlDir = join(work, `npgsql-${npgsql.version}-${sha256(expectedMarker).slice(0, 12)}`);
for (const old of readdirSync(work).filter((name) => name.startsWith('npgsql-') && join(work, name) !== npgsqlDir)) {
  try {
    rmSync(join(work, old), { recursive: true, force: true });
  } catch {
    console.warn(`(left ${join(work, old)}: in use)`);
  }
}
const marker = join(npgsqlDir, '.bfwc-build');
if (!existsSync(marker) || readFileSync(marker, 'utf8') !== expectedMarker) {
  // Missing or interrupted: start again from a clean fetch of the commit.
  removeBuilt(npgsqlDir);
  mkdirSync(npgsqlDir, { recursive: true });
  const git = (...args) => run('git', ['-c', 'core.autocrlf=false', ...args], { cwd: npgsqlDir });
  git('init', '--quiet');
  git('remote', 'add', 'origin', npgsql.repository);
  git('fetch', '--quiet', '--depth', '1', 'origin', npgsql.commit);
  git('checkout', '--quiet', '--detach', 'FETCH_HEAD');
  const head = read('git', ['rev-parse', 'HEAD'], { cwd: npgsqlDir });
  if (head !== npgsql.commit) throw new Error(`Npgsql fetched at ${head}, not the pinned ${npgsql.commit}.`);
  git('apply', '--whitespace=nowarn', join(hostDir, 'patches', 'npgsql-browser.patch'));
  // Npgsql's own global.json pins an older SDK (rolling forward to any): build it with ours.
  writeFileSync(join(npgsqlDir, 'global.json'), globalJson);
  writeFileSync(marker, expectedMarker);
}
// Analyzers newer than the commit's may warn where it was clean: warnings stay warnings (TreatWarningsAsErrors
// off), so NuGetAudit stays on and reports — the source generator's build-only Scriban dependency has
// advisories, and nothing of it ships in the bundle.
run('dotnet', ['build', 'src/Npgsql/Npgsql.csproj', '-c', 'Release', '-f', 'net8.0', '-p:DeveloperBuild=True', '-p:TreatWarningsAsErrors=false', '-p:MSBuildTreatWarningsAsErrors=false', '-nologo', '-v:q'], { cwd: npgsqlDir });
const npgsqlDll = join(npgsqlDir, 'src', 'Npgsql', 'bin', 'Release', 'net8.0', 'Npgsql.dll');

// 2. The host program for browser-wasm, its packages restored exactly as packages.lock.json records.
const hostOut = join(work, 'host');
removeBuilt(hostOut);
run('dotnet', ['build', 'BfwcDotnetHost.csproj', '-c', 'Release', '-nologo', '-v:q', '-p:RestoreLockedMode=true', `-p:NpgsqlDll=${npgsqlDll}`, '-o', hostOut], { cwd: hostDir });
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
    entries.push({ name: basename(file), offset, length: bytes.length, sha256: sha256(bytes) });
    chunks.push(bytes);
    offset += bytes.length;
  }
  writeFileSync(join(out, 'refs', `${group}.bin`), Buffer.concat(chunks));
  references[group] = { pack: `refs/${group}.bin`, files: entries };
};
pack('netcore', dllsIn(refDir('Microsoft.NETCore.App.Ref')));
pack('aspnetcore', dllsIn(refDir('Microsoft.AspNetCore.App.Ref')).filter((file) => runnable.has(basename(file))));
pack('npgsql', [npgsqlDll]);

// 4. The manifest, with every file's hash.
const hashes = {};
const hashAll = (dir) => {
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (statSync(path).isDirectory()) hashAll(path);
    else hashes[relative(out, path).split('\\').join('/')] = sha256(readFileSync(path));
  }
};
hashAll(out);
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
  files: hashes,
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const size = (dir) => readdirSync(dir).reduce((total, file) => total + (statSync(join(dir, file)).isDirectory() ? size(join(dir, file)) : statSync(join(dir, file)).size), 0);
console.log(`.NET runtime bundle (SDK ${sdkVersion}, runtime ${runtimeVersion}) in ${out}: ${(size(out) / 1048576).toFixed(1)} MiB`);
