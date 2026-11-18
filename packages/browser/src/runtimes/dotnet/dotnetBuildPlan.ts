/**
 * What `dotnet build` compiles, decided here so the host program (dotnet-host/
 * CompileService.cs) only runs Roslyn: the project to build (one `.csproj` in
 * the directory, or the one named), its sources (every `.cs` under the project
 * but `bin/` and `obj/`, less `<Compile Remove>`), the implicit and declared
 * global usings, options, defines, where the assembly goes, and which
 * reference groups and bundled packages it compiles against.
 *
 * What the bundle cannot build is refused with a reason: SDKs other than
 * Microsoft.NET.Sdk(.Web/.Worker), target frameworks other than .NET 5–10,
 * project references, and NuGet packages the bundle does not carry (analyzers
 * marked `PrivateAssets="all"` are skipped; Microsoft.Extensions.* packages
 * that ASP.NET Core's shared framework carries are satisfied by it).
 */
import { basename, dirname, normalizePath, resolveFrom } from '@seanhogg/builderforce-webcontainers-core';
import { DOTNET_BUNDLE } from './dotnetBundle.js';
import { globMatcher, parseFileBasedProgram, parseProjectFile, type ProjectFile } from './dotnetProjectFile.js';

/** The project files the planner reads (a `VirtualFileSystem` is one). */
export interface ProjectFiles {
  readText(path: string): string | undefined;
  /** Every file path. */
  list(): string[];
  isDirectory(path: string): boolean;
}

export interface DotnetBuildPlan {
  projectFile: string;
  projectDir: string;
  sdk: string;
  /** An ASP.NET Core project (the Web SDK, or a FrameworkReference to Microsoft.AspNetCore.App). */
  web: boolean;
  fileBased: boolean;
  assemblyName: string;
  outputKind: 'exe' | 'library';
  /** VFS path of the assembly (for a file-based program: a path in the runtime's scratch space, not the project). */
  outputPath: string;
  outputInProject: boolean;
  sources: string[];
  /** C# source declaring the global usings. */
  globalUsings: string;
  nullable: string;
  allowUnsafe: boolean;
  /** The project's LangVersion, else the SDK's default for its target framework (net8.0 → 12, net9.0 → 13, net10.0 → 14). */
  langVersion: string;
  defines: string[];
  optimize: boolean;
  warningsAsErrors: boolean;
  noWarn: string[];
  /** Reference groups of the bundle's manifest (`netcore`, `aspnetcore`). */
  referenceGroups: string[];
  /** Bundled packages (lower-cased ids) the project references. */
  packages: string[];
  /** Notes for the build output (packages resolved to the bundled version). */
  notes: string[];
}

export type PlanResult = { ok: true; plan: DotnetBuildPlan } | { ok: false; reason: string };

const SUPPORTED_SDKS = new Set(['microsoft.net.sdk', 'microsoft.net.sdk.web', 'microsoft.net.sdk.worker']);

/** Packages ASP.NET Core's shared framework carries: referencing them needs nothing beyond it. */
const SHARED_FRAMEWORK_PACKAGE = /^Microsoft\.Extensions\.(?:Caching\.(?:Abstractions|Memory)|Configuration(?:\.(?:Abstractions|Binder|CommandLine|EnvironmentVariables|FileExtensions|Ini|Json|UserSecrets|Xml))?|DependencyInjection(?:\.Abstractions)?|Diagnostics(?:\.Abstractions|\.HealthChecks(?:\.Abstractions)?)?|Features|FileProviders\.(?:Abstractions|Composite|Embedded|Physical)|FileSystemGlobbing|Hosting(?:\.Abstractions)?|Http|Localization(?:\.Abstractions)?|Logging(?:\.(?:Abstractions|Configuration|Console|Debug|EventSource|TraceSource))?|ObjectPool|Options(?:\.(?:ConfigurationExtensions|DataAnnotations))?|Primitives|WebEncoders)$/i;

const COMMON_USINGS = ['System', 'System.Collections.Generic', 'System.IO', 'System.Linq', 'System.Net.Http', 'System.Threading', 'System.Threading.Tasks'];
const WEB_USINGS = ['System.Net.Http.Json', 'Microsoft.AspNetCore.Builder', 'Microsoft.AspNetCore.Hosting', 'Microsoft.AspNetCore.Http', 'Microsoft.AspNetCore.Routing', 'Microsoft.Extensions.Configuration', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'];
const WORKER_USINGS = ['Microsoft.Extensions.Configuration', 'Microsoft.Extensions.DependencyInjection', 'Microsoft.Extensions.Hosting', 'Microsoft.Extensions.Logging'];

const isTrue = (value: string | undefined) => (value ?? '').trim().toLowerCase() === 'true';
const enabled = (value: string | undefined) => ['enable', 'true'].includes((value ?? '').trim().toLowerCase());
const list = (value: string | undefined) => (value ?? '').split(/[;,]/).map((entry) => entry.trim()).filter(Boolean);

/** The project a command means: `target` (a `.csproj`, or a directory holding one) resolved from `cwd`, else the one in `cwd`. */
export function findProject(files: ProjectFiles, cwd: string, target: string | undefined, verb: 'run' | 'build'): { ok: true; path: string } | { ok: false; reason: string } {
  const path = target ? resolveFrom(cwd, target) : cwd;
  if (/\.csproj$/i.test(path)) return files.readText(path) === undefined ? { ok: false, reason: `MSB1009: Project file does not exist. Switch: ${target}` } : { ok: true, path };
  if (/\.(?:fs|vb)proj$/i.test(path)) return { ok: false, reason: `${basename(path)}: only C# projects build in the browser runtime.` };
  if (!files.isDirectory(path)) return { ok: false, reason: `MSB1009: Project file does not exist. Switch: ${target ?? path}` };
  const prefix = path === '/' ? '/' : `${path}/`;
  const projects = files.list().filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/') && /\.csproj$/i.test(file));
  if (projects.length === 1) return { ok: true, path: projects[0]! };
  if (projects.length > 1) return { ok: false, reason: 'MSB1011: Specify which project or solution file to use because this folder contains more than one project or solution file.' };
  return {
    ok: false,
    reason: verb === 'run' ? `Couldn't find a project to run. Ensure a project exists in ${path}, or pass the path to the project using --project.` : 'MSB1003: Specify a project or solution file. The current working directory does not contain a project or solution file.',
  };
}

/** Preprocessor symbols for a .NET target framework (`net8.0` → NET, NET8_0, NET8_0_OR_GREATER … NET5_0_OR_GREATER, NETCOREAPP…). */
export function frameworkDefines(major: number, minor: number): string[] {
  const defines = ['NET', 'NETCOREAPP', `NET${major}_${minor}`];
  for (let version = major; version >= 5; version--) defines.push(`NET${version}_0_OR_GREATER`);
  defines.push('NETCOREAPP1_0_OR_GREATER', 'NETCOREAPP2_0_OR_GREATER', 'NETCOREAPP3_0_OR_GREATER', 'NETCOREAPP3_1_OR_GREATER');
  return defines;
}

function globalUsingsOf(project: ProjectFile, web: boolean): string {
  const usings: string[] = [];
  if (enabled(project.properties.implicitusings)) {
    usings.push(...COMMON_USINGS);
    if (web) usings.push(...WEB_USINGS);
    else if (project.sdk.toLowerCase() === 'microsoft.net.sdk.worker') usings.push(...WORKER_USINGS);
  }
  const removed = new Set(project.usings.filter((item) => item.remove).map((item) => item.include));
  const lines = usings.filter((name) => !removed.has(name)).map((name) => `global using global::${name};`);
  for (const item of project.usings) {
    if (item.remove || removed.has(item.include)) continue;
    if (item.alias) lines.push(`global using ${item.alias} = global::${item.include};`);
    else lines.push(`global using ${item.static ? 'static ' : ''}global::${item.include};`);
  }
  return lines.length ? `// <auto-generated/>\n${[...new Set(lines)].join('\n')}\n` : '';
}

/** The build plan for a project file (`.csproj`) or file-based program (`.cs`) at `path`. */
export function planBuild(files: ProjectFiles, path: string, configuration: string, outputDir?: string): PlanResult {
  const text = files.readText(path);
  if (text === undefined) return { ok: false, reason: `${path} does not exist.` };
  let project: ProjectFile;
  try {
    project = /\.cs$/i.test(path) ? parseFileBasedProgram(text, path) : parseProjectFile(text, path, configuration);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const name = basename(path);
  if (!SUPPORTED_SDKS.has(project.sdk.toLowerCase())) return { ok: false, reason: `${name}: the ${project.sdk} SDK is not available in the browser runtime (it builds Microsoft.NET.Sdk, .Web and .Worker projects).` };
  const tfm = project.properties.targetframework ?? '';
  const framework = /^net(\d+)\.(\d+)$/i.exec(tfm);
  if (!framework || Number(framework[1]) < 5) return { ok: false, reason: `${name}: target framework "${tfm || '(none)'}" is not available in the browser runtime (it runs .NET 5–10 projects as ${DOTNET_BUNDLE.targetFramework}).` };
  if (Number(framework[1]) > 10) return { ok: false, reason: `${name} targets ${tfm}; the browser runtime is ${DOTNET_BUNDLE.targetFramework}.` };
  if (project.projectReferences.length) return { ok: false, reason: `${name}: project references (${project.projectReferences.join(', ')}) are not built in the browser runtime: build one project.` };

  const notes: string[] = [];
  const packages: string[] = [];
  const unavailable: string[] = [];
  let sharedFramework = false;
  for (const reference of project.packages) {
    const bundled = DOTNET_BUNDLE.packages[reference.name.toLowerCase()];
    if (bundled) {
      packages.push(reference.name.toLowerCase());
      if (reference.version && reference.version !== bundled.version) notes.push(`${reference.name} ${reference.version} resolves to the bundled ${bundled.version}.`);
    } else if (SHARED_FRAMEWORK_PACKAGE.test(reference.name)) sharedFramework = true;
    else if (!reference.privateAssets) unavailable.push(reference.name);
  }
  if (unavailable.length) {
    const carried = Object.values(DOTNET_BUNDLE.packages).map((pkg) => `${pkg.name} ${pkg.version}`).join(', ');
    return { ok: false, reason: `${name} references NuGet packages the browser runtime does not carry: ${unavailable.join(', ')} (bundled: ${carried}).` };
  }

  const sdk = project.sdk.toLowerCase();
  const web = sdk === 'microsoft.net.sdk.web' || project.frameworkReferences.some((reference) => reference.toLowerCase() === 'microsoft.aspnetcore.app');
  const props = project.properties;
  const assemblyName = props.assemblyname || name.replace(/\.(?:csproj|cs)$/i, '');
  // It names the output file: a path in it would write (and `clean` remove) outside the project's bin/.
  if (!validAssemblyName(assemblyName)) return { ok: false, reason: `${name}: AssemblyName "${assemblyName}" is not a valid assembly name (it names a file: no / \\ or :, and not . or ..).` };
  const outputType = (props.outputtype || (sdk === 'microsoft.net.sdk' ? 'Library' : 'Exe')).toLowerCase();
  const release = configuration.toLowerCase() === 'release';
  const prefix = project.dir === '/' ? '/' : `${project.dir}/`;
  const removed = project.compileRemove.map(globMatcher);
  const sources = project.fileBased
    ? [path]
    : files
        .list()
        .filter((file) => file.startsWith(prefix) && /\.cs$/i.test(file))
        .filter((file) => {
          const relative = file.slice(prefix.length);
          return !/^(?:bin|obj)\//i.test(relative) && !removed.some((matches) => matches(relative));
        })
        .sort();
  if (!sources.length) return { ok: false, reason: `${name}: no C# sources (.cs files) in ${project.dir}.` };

  for (const ignored of msbuildFilesAbove(files, project.dir)) notes.push(`${ignored} is ignored: the browser runtime does not read MSBuild imports.`);

  const defines = [...list(expandDefines(props.defineconstants)), ...(release ? ['RELEASE'] : ['DEBUG']), 'TRACE', ...frameworkDefines(Number(framework[1]), Number(framework[2]))];
  const outputPath = project.fileBased
    ? `/tmp/dotnet-run/${assemblyName}/${assemblyName}.dll`
    : normalizePath(`${outputDir ? resolveFrom(project.dir, outputDir) : `${project.dir}/bin/${configuration}/${tfm.toLowerCase()}`}/${assemblyName}.dll`);
  return {
    ok: true,
    plan: {
      projectFile: path,
      projectDir: project.dir,
      sdk: project.sdk,
      web,
      fileBased: project.fileBased,
      assemblyName,
      outputKind: outputType === 'exe' || outputType === 'winexe' ? 'exe' : 'library',
      outputPath,
      outputInProject: !project.fileBased,
      sources,
      globalUsings: globalUsingsOf(project, web),
      nullable: (props.nullable || 'disable').toLowerCase(),
      allowUnsafe: isTrue(props.allowunsafeblocks),
      langVersion: props.langversion || defaultLangVersion(Number(framework[1])),
      defines: [...new Set(defines)],
      optimize: props.optimize ? isTrue(props.optimize) : release,
      warningsAsErrors: isTrue(props.treatwarningsaserrors),
      noWarn: ['1701', '1702', ...list(props.nowarn)],
      referenceGroups: web || sharedFramework || packages.length ? ['netcore', 'aspnetcore'] : ['netcore'],
      packages,
      notes,
    },
  };
}

/** The C# version the SDK compiles a target framework with when the project sets none (net5.0 → 9 … net10.0 → 14). */
export const defaultLangVersion = (frameworkMajor: number) => String(frameworkMajor + 4);

/** MSBuild files the SDK would import from the project's directory or above it: named in a build note, never read. */
const MSBUILD_IMPORTS = ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props'];

function msbuildFilesAbove(files: ProjectFiles, dir: string): string[] {
  const found: string[] = [];
  for (let at = dir; ; at = dirname(at)) {
    for (const file of MSBUILD_IMPORTS) if (files.readText(`${at === '/' ? '' : at}/${file}`) !== undefined) found.push(`${at === '/' ? '' : at}/${file}`);
    if (at === '/') return found;
  }
}

/** An assembly name usable as a file name: no separators or drive colon, not `.`/`..`, no control characters. */
export const validAssemblyName = (name: string) => !!name.trim() && !/[/\\:\u0000-\u001f]/.test(name) && name !== '.' && name !== '..';

/**
 * What `dotnet clean` removes: the files the build produced (the assembly), and
 * only when they are strictly under the project's `bin/` — anything else is
 * refused with the reason. A file-based program's output lives outside the
 * project: nothing to remove.
 */
export function cleanTargets(plan: Pick<DotnetBuildPlan, 'projectDir' | 'outputPath' | 'outputInProject'>): { ok: true; paths: string[] } | { ok: false; reason: string } {
  if (!plan.outputInProject) return { ok: true, paths: [] };
  const bin = `${plan.projectDir === '/' ? '' : normalizePath(plan.projectDir)}/bin/`;
  const output = normalizePath(plan.outputPath);
  if (!output.startsWith(bin) || output.length <= bin.length) return { ok: false, reason: `Refusing to clean ${output}: it is not under ${bin}.` };
  return { ok: true, paths: [output] };
}

/** `$(DefineConstants)` inside DefineConstants is the SDK's own list (already added): drop the reference. */
const expandDefines = (value: string | undefined) => (value ?? '').replace(/\$\(DefineConstants\)/gi, '');
