/**
 * The .NET runtime's guards: `dotnet clean` never reaches outside the
 * project's bin/ (a hostile AssemblyName is declined; clean removes only the
 * built assembly), the project scan is linear and refuses what it cannot build
 * faithfully, `#:` directives count only at the top of a file-based program,
 * LangVersion follows the target framework, `-p:A=1;B=2` is read as MSBuild
 * reads it, and the loader refuses a bundle whose files do not match their
 * manifest hashes or whose packed entries are out of bounds — with one line,
 * never a stack.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { cleanTargets, defaultLangVersion, planBuild } from '../src/runtimes/dotnet/dotnetBuildPlan.js';
import { parseDotnetCommand } from '../src/runtimes/dotnet/dotnetCommand.js';
import { DOTNET_BUNDLE } from '../src/runtimes/dotnet/dotnetBundle.js';
import { DotnetBundleError, loadDotnetRuntime, sha256Hex, type DotnetBundleManifest, type DotnetImports } from '../src/runtimes/dotnet/dotnetLoader.js';
import { parseProjectFile, runDirectives } from '../src/runtimes/dotnet/dotnetProjectFile.js';
import { dotnetHost } from './dotnet-helpers.js';
import { readAll } from './php-helpers.js';

const files = (tree: Record<string, string>) => {
  const fs = new VirtualFileSystem();
  fs.writeTree(tree);
  return fs;
};

const project = (body: string, sdk = 'Microsoft.NET.Sdk') => `<Project Sdk="${sdk}"><PropertyGroup><TargetFramework>net8.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup>${body}</Project>`;

const plan = (csproj: string, tree: Record<string, string> = {}) => planBuild(files({ 'p/p.csproj': csproj, 'p/a.cs': '', ...tree }), '/p/p.csproj', 'Debug');
const reason = (result: ReturnType<typeof planBuild>) => (result.ok ? 'accepted' : result.reason);

describe('dotnet clean stays inside bin/', () => {
  it('declines an AssemblyName that is a path, or . / ..', () => {
    for (const name of ['../../../../x', 'a/b', 'a\\b', 'c:x', '.', '..']) {
      expect(reason(plan(project(`<PropertyGroup><AssemblyName>${name}</AssemblyName></PropertyGroup>`)))).toContain('not a valid assembly name');
    }
    expect(plan(project('<PropertyGroup><AssemblyName>My.App</AssemblyName></PropertyGroup>'))).toMatchObject({ ok: true, plan: { outputPath: '/p/bin/Debug/net8.0/My.App.dll' } });
  });

  it('cleans only the built assembly, and refuses any path not strictly under the project bin/', () => {
    expect(cleanTargets({ projectDir: '/p', outputPath: '/p/bin/Debug/net8.0/app.dll', outputInProject: true })).toEqual({ ok: true, paths: ['/p/bin/Debug/net8.0/app.dll'] });
    expect(cleanTargets({ projectDir: '/p', outputPath: '/p/bin/../../etc/app.dll', outputInProject: true })).toMatchObject({ ok: false, reason: expect.stringContaining('not under /p/bin/') });
    expect(cleanTargets({ projectDir: '/p', outputPath: '/p/bin/', outputInProject: true })).toMatchObject({ ok: false });
    expect(cleanTargets({ projectDir: '/p', outputPath: '/', outputInProject: true })).toMatchObject({ ok: false });
    expect(cleanTargets({ projectDir: '/', outputPath: '/bin/Debug/x.dll', outputInProject: true })).toEqual({ ok: true, paths: ['/bin/Debug/x.dll'] });
    expect(cleanTargets({ projectDir: '/t', outputPath: '/tmp/dotnet-run/app/app.dll', outputInProject: false })).toEqual({ ok: true, paths: [] });
  });

  it('a clean process removes the assembly and leaves the rest of bin/ and the project', async () => {
    const { fs, processes } = dotnetHost(
      { 'api/api.csproj': project(''), 'api/Program.cs': '', 'api/bin/Debug/net8.0/api.dll': 'built', 'api/bin/Debug/net8.0/keep.json': '{}', 'api/notes.txt': 'x' },
      () => Promise.reject(new Error('clean must not load the runtime')),
    );
    const proc = processes.run('dotnet', ['clean'], { cwd: '/api' });
    expect(await readAll(proc.combinedOutput)).toContain('Deleting file "/api/bin/Debug/net8.0/api.dll"');
    expect(await proc.wait()).toBe(0);
    expect(fs.isFile('/api/bin/Debug/net8.0/api.dll')).toBe(false);
    expect(fs.readText('/api/bin/Debug/net8.0/keep.json')).toBe('{}');
    expect(fs.readText('/api/notes.txt')).toBe('x');
    processes.dispose();
  });
});

describe('the project scan', () => {
  it('declines what it cannot build faithfully, with the reason', () => {
    expect(reason(plan(project('<PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>')))).toContain('EnableDefaultCompileItems');
    expect(reason(plan(project('<ItemGroup><Compile Include="../shared/Util.cs" /></ItemGroup>')))).toContain('outside its project');
    expect(reason(plan(project('<ItemGroup><Compile Include="Extra/*.cs" /></ItemGroup>')))).toBe('accepted');
    expect(reason(plan(project('<Target Name="X" BeforeTargets="Build"><PropertyGroup><DefineConstants>Y</DefineConstants></PropertyGroup></Target>')))).toContain('inside a <Target>');
  });

  it('expands properties in Compile Remove, resolves Choose, and notes Directory.Build.props', () => {
    const csproj = project('<PropertyGroup><Legacy>Old</Legacy></PropertyGroup><Choose><When Condition="\'$(Configuration)\' == \'Release\'"><PropertyGroup><Mode>r</Mode></PropertyGroup></When><Otherwise><PropertyGroup><Mode>d</Mode></PropertyGroup></Otherwise></Choose><ItemGroup><Compile Remove="$(Legacy)/**" /></ItemGroup>');
    const parsed = parseProjectFile(csproj, '/p/p.csproj', 'Debug');
    expect(parsed.compileRemove).toEqual(['Old/**']);
    expect(parsed.properties.mode).toBe('d');
    expect(parseProjectFile(csproj, '/p/p.csproj', 'Release').properties.mode).toBe('r');
    const planned = plan(csproj, { 'p/Old/x.cs': '', 'Directory.Build.props': '<Project/>' });
    expect(planned).toMatchObject({ ok: true, plan: { sources: ['/p/a.cs'] } });
    expect(planned.ok && planned.plan.notes).toContain('/Directory.Build.props is ignored: the browser runtime does not read MSBuild imports.');
  });

  it('reads malformed XML in linear time', () => {
    const hostile = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${'<A'.repeat(60_000)}${' x'.repeat(60_000)}`;
    const started = performance.now();
    expect(() => parseProjectFile(hostile, '/p/p.csproj', 'Debug')).not.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('defaults LangVersion by target framework', () => {
    expect([5, 6, 7, 8, 9, 10].map(defaultLangVersion)).toEqual(['9', '10', '11', '12', '13', '14']);
    expect(plan(project(''))).toMatchObject({ ok: true, plan: { langVersion: '12' } });
    expect(plan(project('<PropertyGroup><LangVersion>preview</LangVersion></PropertyGroup>'))).toMatchObject({ ok: true, plan: { langVersion: 'preview' } });
  });

  it('reads `#:` directives only at the top of a file-based program', () => {
    const text = '#!/usr/bin/env dotnet\n// a comment\n\n#:property LangVersion=13\n#:package Npgsql@9.0.3\nConsole.WriteLine(1);\n#:property Nullable=disable\n';
    expect(runDirectives(text).map((directive) => directive.kind)).toEqual(['property', 'package']);
    expect(planBuild(files({ 't/app.cs': text }), '/t/app.cs', 'Debug')).toMatchObject({ ok: true, plan: { nullable: 'enable', langVersion: '13', fileBased: true } });
  });

  it('reads -p:Name=Value;Other=Value as MSBuild does', () => {
    expect(parseDotnetCommand('dotnet', ['build', '-p:Configuration=Release;Version=1.2'])).toMatchObject({ ok: true, invocation: { configuration: 'Release' } });
    expect(parseDotnetCommand('dotnet', ['build', '-p:Version=1;Configuration=Staging'])).toMatchObject({ ok: true, invocation: { configuration: 'Staging' } });
  });
});

describe('the bundle loader', () => {
  const imports = {} as DotnetImports;
  const text = (value: string) => new TextEncoder().encode(value);

  /** A bundle served from memory: `tamper` changes one file's bytes after its hash was taken. */
  async function bundle(options: { tamper?: string; offset?: number } = {}) {
    const entry = text('export const dotnet = {};');
    const dll = text('MZ-fake-assembly');
    const pack = new Uint8Array([...dll]);
    const served = new Map<string, Uint8Array>([
      ['_framework/dotnet.js', entry],
      ['refs/netcore.bin', pack],
    ]);
    const manifest: DotnetBundleManifest = {
      format: DOTNET_BUNDLE.format,
      sdkVersion: '10.0.100',
      runtimeVersion: '10.0.0',
      targetFramework: 'net10.0',
      entry: '_framework/dotnet.js',
      assembly: 'Bfwc.DotnetHost',
      references: { netcore: { pack: 'refs/netcore.bin', files: [{ name: 'System.Runtime.dll', offset: options.offset ?? 0, length: dll.length, sha256: await sha256Hex(dll) }] } },
      packages: {},
      files: { '_framework/dotnet.js': await sha256Hex(entry), 'refs/netcore.bin': await sha256Hex(pack) },
    };
    if (options.tamper) served.set(options.tamper, text('tampered'));
    const fetchFn: typeof fetch = async (input) => {
      const path = String(input).replace('https://bundle.test/', '');
      if (path === 'manifest.json') return new Response(JSON.stringify(manifest));
      const bytes = served.get(path);
      return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('missing', { status: 404 });
    };
    const written = new Map<string, Uint8Array>();
    const FS = { mkdirTree() {}, writeFile: (path: string, data: Uint8Array) => written.set(path, data) };
    const builder = {
      withEnvironmentVariables: () => builder,
      withModuleConfig: () => builder,
      withResourceLoader: () => builder,
      create: async () => ({ Module: { FS }, setModuleImports() {}, getAssemblyExports: async () => ({ Bfwc: { Host: { Exports: {} } } }) }),
    };
    const load = () => loadDotnetRuntime({ bundleUrl: 'https://bundle.test/', env: {}, imports, fetch: fetchFn, importModule: async () => ({ dotnet: builder }) });
    return { load, written };
  }

  it('loads a bundle whose files match their hashes', async () => {
    const { load, written } = await bundle();
    const loaded = await load();
    expect([...(await loaded.mountReferences(['netcore'])).keys()]).toEqual(['netcore/System.Runtime.dll']);
    expect(new TextDecoder().decode(written.get('/dotnet/refs/netcore/System.Runtime.dll'))).toBe('MZ-fake-assembly');
  });

  it('refuses dotnet.js that does not match its hash, before running it', async () => {
    const { load } = await bundle({ tamper: '_framework/dotnet.js' });
    await expect(load()).rejects.toThrow(DotnetBundleError);
    await expect(load()).rejects.toThrow(/_framework\/dotnet\.js .* does not match/);
  });

  it('refuses a tampered pack, and a packed entry out of bounds', async () => {
    const tampered = await (await bundle({ tamper: 'refs/netcore.bin' })).load();
    await expect(tampered.mountReferences(['netcore'])).rejects.toThrow(/refs\/netcore\.bin .* does not match/);
    const outOfBounds = await (await bundle({ offset: 4 })).load();
    await expect(outOfBounds.mountReferences(['netcore'])).rejects.toThrow(/out of bounds/);
  });

  it('an unreachable bundle ends the process with one line, no stack', async () => {
    const { processes } = dotnetHost({ 'api/api.csproj': project(''), 'api/Program.cs': '' }, (options) => loadDotnetRuntime({ ...options, fetch: () => Promise.reject(new TypeError('Failed to fetch')) }), { bundleUrl: 'https://gone.test/dotnet/' });
    const proc = processes.run('dotnet', ['run'], { cwd: '/api' });
    const output = await readAll(proc.combinedOutput);
    expect(output).toBe('The .NET runtime bundle could not be reached (https://gone.test/dotnet/manifest.json: Failed to fetch).\n');
    expect(await proc.wait()).toBe(1);
    const info = processes.run('dotnet', ['--version'], { cwd: '/api' });
    expect(await readAll(info.combinedOutput)).not.toMatch(/\n\s+at /);
    expect(await info.wait()).toBe(1);
    processes.dispose();
  });
});
