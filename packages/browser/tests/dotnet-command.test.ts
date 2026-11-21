/**
 * The .NET runtime's pure parts: `dotnet` command lines, `.csproj` and
 * file-based program reading, build plans (sources, usings, defines, output,
 * what is declined and why), launch profiles, and the provider's acceptance.
 */
import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import {
  acceptsDotnetService,
  compilePlan,
  evaluateCondition,
  findProject,
  globMatcher,
  parseDotnetCommand,
  parseFileBasedProgram,
  parseProjectFile,
  planBuild,
  readLaunchProfile,
  type DotnetBundleManifest,
} from '../src/runtimes/dotnet/index.js';
import { DOTNET_BUNDLE, DOTNET_BUNDLE_SOURCE } from '../src/runtimes/dotnet/dotnetBundle.js';
import { readManifest } from '../src/runtimes/dotnet/dotnetLoader.js';
import { DOTNET_BUNDLE_PACKAGE } from '../src/launcher/server/dotnetBundle.js';

const WEB = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <DefineConstants>$(DefineConstants);FEATURE_X</DefineConstants>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)' == 'Release'">
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Npgsql" Version="8.0.5" />
    <PackageReference Include="StyleCop.Analyzers" Version="1.1.118" PrivateAssets="all" />
    <Using Include="System.Text.Json" />
    <Using Include="System.Math" Static="true" />
    <Using Remove="System.Net.Http" />
    <Compile Remove="Legacy/**" />
  </ItemGroup>
</Project>`;

const files = (tree: Record<string, string>) => {
  const fs = new VirtualFileSystem();
  fs.writeTree(tree);
  return fs;
};

describe('dotnet command lines', () => {
  it('parses run with its options, a launch profile and program arguments', () => {
    expect(parseDotnetCommand('dotnet', ['run', '--project', 'api', '-c', 'Release', '--urls', 'http://localhost:8080', '--', '--verbose'])).toEqual({
      ok: true,
      invocation: { kind: 'run', project: 'api', configuration: 'Release', noBuild: false, launchProfile: undefined, appArgs: ['--urls', 'http://localhost:8080', '--verbose'] },
    });
    expect(parseDotnetCommand('/usr/bin/dotnet', ['run', '--no-launch-profile', '--no-build', '-p:Configuration=Release'])).toMatchObject({ ok: true, invocation: { configuration: 'Release', noBuild: true, launchProfile: null } });
    expect(parseDotnetCommand('dotnet', ['run', '-lp', 'https'])).toMatchObject({ invocation: { launchProfile: 'https' } });
  });

  it('parses file-based programs, assemblies, build, clean, restore and the informational switches', () => {
    expect(parseDotnetCommand('dotnet', ['run', 'app.cs', 'a'])).toMatchObject({ ok: true, invocation: { kind: 'run', file: 'app.cs', appArgs: ['a'] } });
    expect(parseDotnetCommand('dotnet', ['tool.cs'])).toMatchObject({ ok: true, invocation: { kind: 'run', file: 'tool.cs' } });
    expect(parseDotnetCommand('dotnet', ['bin/Debug/net10.0/api.dll', 'x'])).toEqual({ ok: true, invocation: { kind: 'exec', assembly: 'bin/Debug/net10.0/api.dll', appArgs: ['x'] } });
    expect(parseDotnetCommand('dotnet', ['build', 'api/api.csproj', '-o', 'out', '--nologo', '-v', 'q'])).toEqual({ ok: true, invocation: { kind: 'build', project: 'api/api.csproj', configuration: 'Debug', output: 'out' } });
    expect(parseDotnetCommand('dotnet', ['clean'])).toEqual({ ok: true, invocation: { kind: 'clean', project: undefined, configuration: 'Debug' } });
    expect(parseDotnetCommand('dotnet', ['--version'])).toEqual({ ok: true, invocation: { kind: 'info', what: 'version' } });
  });

  it('declines what the browser runtime cannot do, with reasons', () => {
    for (const verb of ['watch', 'test', 'publish', 'new', 'ef']) {
      const parsed = parseDotnetCommand('dotnet', [verb]);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? '' : parsed.reason).toMatch(/not available|browser runtime/);
    }
    expect(parseDotnetCommand('dotnet', ['build', 'All.sln'])).toMatchObject({ ok: false, reason: expect.stringContaining('Solutions') });
    expect(parseDotnetCommand('dotnet', ['build', '--bogus'])).toEqual({ ok: false, reason: "Unknown option '--bogus'." });
    expect(parseDotnetCommand('dotnet', ['run', '--project'])).toMatchObject({ ok: false });
    expect(parseDotnetCommand('node', ['run']).ok).toBe(false);
  });
});

describe('.NET projects', () => {
  it('reads properties under conditions, packages, usings and compile removals', () => {
    const debug = parseProjectFile(WEB, '/api/api.csproj', 'Debug');
    expect(debug.sdk).toBe('Microsoft.NET.Sdk.Web');
    expect(debug.properties.targetframework).toBe('net8.0');
    expect(debug.properties.defineconstants).toBe(';FEATURE_X');
    expect(debug.properties.treatwarningsaserrors).toBeUndefined();
    expect(parseProjectFile(WEB, '/api/api.csproj', 'Release').properties.treatwarningsaserrors).toBe('true');
    expect(debug.packages).toEqual([
      { name: 'Npgsql', version: '8.0.5', privateAssets: false },
      { name: 'StyleCop.Analyzers', version: '1.1.118', privateAssets: true },
    ]);
    expect(debug.usings).toEqual([
      { include: 'System.Text.Json', static: false, remove: false },
      { include: 'System.Math', static: true, remove: false },
      { include: 'System.Net.Http', static: false, remove: true },
    ]);
    expect(debug.compileRemove).toEqual(['Legacy/**']);
    expect(() => parseProjectFile('<Project><PropertyGroup/></Project>', '/x.csproj', 'Debug')).toThrow(/SDK-style/);
  });

  it('evaluates simple conditions and globs', () => {
    expect(evaluateCondition("'$(Configuration)|$(Platform)' == 'Debug|AnyCPU'", { configuration: 'Debug', platform: 'AnyCPU' })).toBe(true);
    expect(evaluateCondition("'$(Configuration)' != 'Debug' and '$(OS)' == 'Unix'", { configuration: 'Release', os: 'Unix' })).toBe(true);
    expect(evaluateCondition("Exists('x')", {})).toBe(false);
    expect(globMatcher('Legacy/**')('Legacy/a/b.cs')).toBe(true);
    expect(globMatcher('**/*.g.cs')('Models/User.g.cs')).toBe(true);
    expect(globMatcher('**/*.g.cs')('User.g.cs')).toBe(true);
    expect(globMatcher('*.cs')('a/b.cs')).toBe(false);
  });

  it('plans a web project: sources, global usings, defines, references and packages', () => {
    const fs = files({ 'api/api.csproj': WEB, 'api/Program.cs': '', 'api/Models/User.cs': '', 'api/Legacy/Old.cs': '', 'api/bin/Debug/x.cs': '', 'api/obj/y.cs': '', 'other/z.cs': '' });
    const planned = planBuild(fs, '/api/api.csproj', 'Debug');
    if (!planned.ok) throw new Error(planned.reason);
    const { plan } = planned;
    expect(plan.sources).toEqual(['/api/Models/User.cs', '/api/Program.cs']);
    expect(plan.outputPath).toBe('/api/bin/Debug/net8.0/api.dll');
    expect(plan.outputKind).toBe('exe');
    expect(plan.web).toBe(true);
    expect(plan.referenceGroups).toEqual(['netcore', 'aspnetcore']);
    expect(plan.packages).toEqual(['npgsql']);
    expect(plan.notes).toEqual(['Npgsql 8.0.5 resolves to the bundled 9.0.3.']);
    expect(plan.globalUsings).toContain('global using global::Microsoft.AspNetCore.Builder;');
    expect(plan.globalUsings).toContain('global using static global::System.Math;');
    expect(plan.globalUsings).not.toContain('System.Net.Http;');
    expect(plan.defines).toEqual(expect.arrayContaining(['FEATURE_X', 'DEBUG', 'TRACE', 'NET', 'NET8_0', 'NET8_0_OR_GREATER', 'NET5_0_OR_GREATER']));
    expect(plan.defines).not.toContain('NET9_0_OR_GREATER');
    expect(plan.nullable).toBe('enable');
    const manifest = {
      references: { netcore: { pack: '', files: [{ name: 'System.Runtime.dll', offset: 0, length: 1 }] }, aspnetcore: { pack: '', files: [{ name: 'Microsoft.AspNetCore.dll', offset: 0, length: 1 }] }, npgsql: { pack: '', files: [{ name: 'Npgsql.dll', offset: 0, length: 1 }] } },
      packages: { npgsql: { name: 'Npgsql', version: '9.0.3', references: ['npgsql/Npgsql.dll'] } },
    } as unknown as DotnetBundleManifest;
    const references = new Map([['netcore/System.Runtime.dll', '/dotnet/refs/netcore/System.Runtime.dll'], ['aspnetcore/Microsoft.AspNetCore.dll', '/dotnet/refs/aspnetcore/Microsoft.AspNetCore.dll'], ['npgsql/Npgsql.dll', '/dotnet/refs/npgsql/Npgsql.dll']]);
    const compiled = JSON.parse(compilePlan(plan, references, manifest, true)) as { sources: string[]; outputPath: string; references: string[]; quiet: boolean };
    expect(compiled.sources).toEqual(['/project/api/Models/User.cs', '/project/api/Program.cs']);
    expect(compiled.outputPath).toBe('/project/api/bin/Debug/net8.0/api.dll');
    expect(compiled.references).toEqual(['/dotnet/refs/netcore/System.Runtime.dll', '/dotnet/refs/aspnetcore/Microsoft.AspNetCore.dll', '/dotnet/refs/npgsql/Npgsql.dll']);
    expect(compiled.quiet).toBe(true);
  });

  it('plans a file-based program from its directives', () => {
    const text = '#!/usr/bin/env dotnet\n#:sdk Microsoft.NET.Sdk.Web\n#:package Npgsql@9.0.3\n#:property LangVersion=preview\nConsole.WriteLine("hi");\n';
    expect(parseFileBasedProgram(text, '/tools/app.cs')).toMatchObject({ sdk: 'Microsoft.NET.Sdk.Web', fileBased: true, packages: [{ name: 'Npgsql', version: '9.0.3' }], properties: { langversion: 'preview' } });
    const planned = planBuild(files({ 'tools/app.cs': text }), '/tools/app.cs', 'Debug');
    expect(planned).toMatchObject({ ok: true, plan: { sources: ['/tools/app.cs'], outputPath: '/tmp/dotnet-run/app/app.dll', outputInProject: false, outputKind: 'exe', web: true, langVersion: 'preview' } });
  });

  it('declines what it cannot build, naming why', () => {
    const decline = (csproj: string) => {
      const planned = planBuild(files({ 'p/p.csproj': csproj, 'p/a.cs': '' }), '/p/p.csproj', 'Debug');
      return planned.ok ? 'accepted' : planned.reason;
    };
    expect(decline('<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>')).toContain('BlazorWebAssembly SDK');
    expect(decline('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>')).toContain('"net48"');
    expect(decline('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net11.0</TargetFramework></PropertyGroup></Project>')).toContain('targets net11.0');
    expect(decline('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><ProjectReference Include="../lib/lib.csproj" /></ItemGroup></Project>')).toContain('project references');
    expect(decline('<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Dapper" Version="2.1.0" /></ItemGroup></Project>')).toContain('Dapper (bundled: Npgsql 9.0.3)');
    expect(decline('<Project Sdk="Microsoft.NET.Sdk.Worker"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Extensions.Hosting" Version="10.0.0" /></ItemGroup></Project>')).toBe('accepted');
  });

  it('finds the project in a directory as the CLI does', () => {
    const fs = files({ 'api/api.csproj': WEB, 'two/a.csproj': WEB, 'two/b.csproj': WEB, 'empty/readme.md': '' });
    expect(findProject(fs, '/api', undefined, 'run')).toEqual({ ok: true, path: '/api/api.csproj' });
    expect(findProject(fs, '/', 'api', 'build')).toEqual({ ok: true, path: '/api/api.csproj' });
    expect(findProject(fs, '/two', undefined, 'build')).toMatchObject({ ok: false, reason: expect.stringContaining('MSB1011') });
    expect(findProject(fs, '/empty', undefined, 'run')).toMatchObject({ ok: false, reason: expect.stringContaining("Couldn't find a project to run") });
    expect(findProject(fs, '/', 'nope.csproj', 'build')).toMatchObject({ ok: false, reason: expect.stringContaining('MSB1009') });
  });

  it('applies the default launch profile, keeping an ASPNETCORE_URLS the process already has', () => {
    const settings = JSON.stringify({ profiles: { http: { commandName: 'Project', applicationUrl: 'http://localhost:5123', environmentVariables: { ASPNETCORE_ENVIRONMENT: 'Development' }, commandLineArgs: '--seed "two words"' }, docker: { commandName: 'Docker' } } });
    const read = (path: string) => (path === '/api/Properties/launchSettings.json' ? settings : undefined);
    expect(readLaunchProfile(read, '/api', undefined, {})).toEqual({ ok: true, profile: { name: 'http', env: { ASPNETCORE_ENVIRONMENT: 'Development', ASPNETCORE_URLS: 'http://localhost:5123' }, args: ['--seed', 'two words'] } });
    expect(readLaunchProfile(read, '/api', undefined, { ASPNETCORE_URLS: 'http://localhost:8080' })).toMatchObject({ profile: { env: { ASPNETCORE_ENVIRONMENT: 'Development' } } });
    expect(readLaunchProfile(read, '/api', null, {})).toEqual({ ok: true });
    expect(readLaunchProfile(read, '/api', 'missing', {})).toMatchObject({ ok: false });
  });
});

describe('dotnet provider', () => {
  const service = (args: string[], root = '/api') => ({ id: 'api', type: 'application' as const, runtime: 'dotnet', command: 'dotnet', args, root, port: 8080 });
  it('accepts runnable projects and declines the rest with reasons', () => {
    const fs = files({ 'api/api.csproj': WEB, 'api/Program.cs': '', 'lib/lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>', 'lib/L.cs': '' });
    expect(acceptsDotnetService(service(['run']), fs)).toEqual({ ok: true });
    expect(acceptsDotnetService(service(['api.dll']), fs)).toEqual({ ok: true });
    expect(acceptsDotnetService(service(['run'], '/lib'), fs)).toMatchObject({ ok: false, reason: expect.stringContaining('class library') });
    expect(acceptsDotnetService(service(['watch']), fs)).toMatchObject({ ok: false, reason: expect.stringContaining('dotnet watch') });
    expect(acceptsDotnetService({ ...service([]), command: 'node' })).toMatchObject({ ok: false });
    expect(acceptsDotnetService({ id: 'db', type: 'database', runtime: 'dotnet', port: 5432 } as never)).toMatchObject({ ok: false });
  });
});

describe('where the .NET bundle comes from', () => {
  it('is spelled once (the launcher reads DOTNET_BUNDLE.npmPackage), and a bundle error names the npm package first', async () => {
    expect(DOTNET_BUNDLE_PACKAGE).toBe(DOTNET_BUNDLE.npmPackage);
    expect(DOTNET_BUNDLE_SOURCE).toContain('install @seanhogg/builderforce-webcontainers-dotnet at the same version');
    expect(DOTNET_BUNDLE_SOURCE).toContain('scripts/build-dotnet-runtime.mjs');
    const oldFormat: typeof fetch = async () => new Response(JSON.stringify({ format: 1 }));
    await expect(readManifest('https://bundle.test/dotnet/', oldFormat)).rejects.toThrow(`To get one this runtime reads, ${DOTNET_BUNDLE_SOURCE}.`);
  });
});
