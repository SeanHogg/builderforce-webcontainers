/**
 * Reading a .NET project as the browser runtime builds it: an SDK-style
 * `.csproj` (its SDK, properties, package/project/framework references,
 * `<Using>` items and `<Compile Remove>` globs), or a file-based program's
 * directives (`#:sdk`, `#:package`, `#:property`, .NET 10's `dotnet run
 * app.cs`). A light scan, not MSBuild: conditions are evaluated when they
 * compare `$(Configuration)`, `$(Platform)`, `$(TargetFramework)` or `$(OS)`
 * with `==`/`!=` (joined by `and`/`or`); anything else counts as false.
 * Imports and Directory.Build.props are not read.
 */
import { basename, dirname } from '@seanhogg/builderforce-webcontainers-core';

export interface PackageRef {
  name: string;
  version?: string;
  /** `PrivateAssets="all"`: a build-time dependency (analyzers), never needed at run time. */
  privateAssets: boolean;
}

export interface UsingItem {
  include: string;
  alias?: string;
  static: boolean;
  remove: boolean;
}

export interface ProjectFile {
  /** VFS path of the `.csproj` (or the `.cs` of a file-based program). */
  path: string;
  dir: string;
  /** Without a version (`Microsoft.NET.Sdk.Web`). */
  sdk: string;
  /** Property names lower-cased. */
  properties: Record<string, string>;
  packages: PackageRef[];
  projectReferences: string[];
  frameworkReferences: string[];
  usings: UsingItem[];
  compileRemove: string[];
  fileBased: boolean;
}

const COMMENTS = /<!--[\s\S]*?-->/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) found[match[1]!.toLowerCase()] = decode(match[2] ?? match[3] ?? '');
  return found;
}

/** `$(Name)` replaced from `values` (lower-cased names); unknown ones become empty, as MSBuild does. */
export function expandProperties(text: string, values: Record<string, string>): string {
  return text.replace(/\$\(([\w.]+)\)/g, (_, name: string) => values[name.toLowerCase()] ?? '');
}

/** A condition, over the properties known so far. */
export function evaluateCondition(condition: string, values: Record<string, string>): boolean {
  const expanded = expandProperties(condition, values).trim();
  if (!expanded) return true;
  const disjuncts = expanded.split(/\s+or\s+/i);
  return disjuncts.some((disjunct) =>
    disjunct.split(/\s+and\s+/i).every((term) => {
      const comparison = /^\(?\s*'([^']*)'\s*(==|!=)\s*'([^']*)'\s*\)?$/.exec(term.trim());
      if (!comparison) return false;
      const same = comparison[1]!.toLowerCase() === comparison[3]!.toLowerCase();
      return comparison[2] === '==' ? same : !same;
    }),
  );
}

/** Elements named `name` inside `text`: their attributes and (for non-empty ones) inner text. */
function elements(text: string, name: string): Array<{ attrs: Record<string, string>; inner: string }> {
  const pattern = new RegExp(`<${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, 'gi');
  return [...text.matchAll(pattern)].map((match) => ({ attrs: attributes(match[1] ?? ''), inner: match[2] ?? '' }));
}

/** The direct children of a group (`<Name>value</Name>`), in order. */
function children(inner: string): Array<{ name: string; attrs: Record<string, string>; value: string }> {
  const pattern = /<([\w.-]+)(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
  return [...inner.matchAll(pattern)].map((match) => ({ name: match[1]!, attrs: attributes(match[2] ?? ''), value: decode((match[3] ?? '').trim()) }));
}

const withoutVersion = (sdk: string) => sdk.split('/')[0]!.trim();

/** Parse a `.csproj` for `configuration`. Throws on what is not an SDK-style project. */
export function parseProjectFile(text: string, path: string, configuration: string): ProjectFile {
  const xml = text.replace(COMMENTS, '');
  const root = /<Project(\s[^>]*)?>/i.exec(xml);
  if (!root) throw new Error(`${basename(path)} is not an MSBuild project (no <Project> element).`);
  const sdk = attributes(root[1] ?? '').sdk ?? elements(xml, 'Sdk')[0]?.attrs.name ?? /<Import\s[^>]*Sdk="([^"]+)"/i.exec(xml)?.[1];
  if (!sdk) throw new Error(`${basename(path)} is not an SDK-style project (no Sdk attribute): the browser runtime builds SDK-style projects only.`);
  const properties: Record<string, string> = {
    configuration,
    platform: 'AnyCPU',
    os: 'Unix',
    msbuildprojectname: basename(path).replace(/\.\w+proj$/i, ''),
    msbuildprojectdirectory: dirname(path),
  };
  const holds = (attrs: Record<string, string>) => attrs.condition === undefined || evaluateCondition(attrs.condition, properties);

  for (const group of elements(xml, 'PropertyGroup')) {
    if (!holds(group.attrs)) continue;
    for (const property of children(group.inner)) {
      if (holds(property.attrs)) properties[property.name.toLowerCase()] = expandProperties(property.value, properties);
    }
  }
  // Conditions on items may name the target framework, known only now.
  properties.targetframework ??= (properties.targetframeworks ?? '').split(';')[0]?.trim() ?? '';

  const project: ProjectFile = { path, dir: dirname(path), sdk: withoutVersion(sdk), properties, packages: [], projectReferences: [], frameworkReferences: [], usings: [], compileRemove: [], fileBased: false };
  for (const group of elements(xml, 'ItemGroup')) {
    if (!holds(group.attrs)) continue;
    for (const item of children(group.inner)) {
      if (!holds(item.attrs)) continue;
      const include = expandProperties(item.attrs.include ?? item.attrs.update ?? '', properties);
      switch (item.name.toLowerCase()) {
        case 'packagereference': {
          if (!item.attrs.include) break; // `Update` only changes a reference made elsewhere
          const nested = Object.fromEntries(children(item.value).map((child) => [child.name.toLowerCase(), child.value]));
          const version = item.attrs.version ?? nested.version;
          const privateAssets = (item.attrs.privateassets ?? nested.privateassets ?? '').toLowerCase() === 'all';
          project.packages.push({ name: include, ...(version ? { version } : {}), privateAssets });
          break;
        }
        case 'projectreference':
          project.projectReferences.push(include);
          break;
        case 'frameworkreference':
          project.frameworkReferences.push(include);
          break;
        case 'using':
          if (item.attrs.remove) project.usings.push({ include: item.attrs.remove, static: false, remove: true });
          else if (include) project.usings.push({ include, ...(item.attrs.alias ? { alias: item.attrs.alias } : {}), static: (item.attrs.static ?? '').toLowerCase() === 'true', remove: false });
          break;
        case 'compile':
          if (item.attrs.remove) project.compileRemove.push(...item.attrs.remove.split(';').map((glob) => glob.trim()).filter(Boolean));
          break;
      }
    }
  }
  return project;
}

/**
 * A file-based program (`app.cs`): an executable with implicit usings and
 * nullable enabled (.NET 10's defaults), shaped by its `#:sdk`, `#:package
 * Name@Version` and `#:property Name=Value` directives. `#:project` is
 * refused (thrown), as project references are.
 */
export function parseFileBasedProgram(text: string, path: string): ProjectFile {
  const properties: Record<string, string> = { outputtype: 'Exe', implicitusings: 'enable', nullable: 'enable', targetframework: 'net10.0' };
  const project: ProjectFile = { path, dir: dirname(path), sdk: 'Microsoft.NET.Sdk', properties, packages: [], projectReferences: [], frameworkReferences: [], usings: [], compileRemove: [], fileBased: true };
  for (const line of text.split(/\r?\n/)) {
    const directive = /^\s*#:(\w+)\s+(.+?)\s*$/.exec(line);
    if (!directive) continue;
    const [, kind, value] = directive as unknown as [string, string, string];
    if (kind === 'sdk') project.sdk = withoutVersion(value.replace('@', '/'));
    else if (kind === 'package') {
      const [name, version] = value.split('@', 2);
      project.packages.push({ name: name!.trim(), ...(version ? { version: version.trim() } : {}), privateAssets: false });
    } else if (kind === 'property') {
      const [name, setting] = value.split('=', 2);
      if (name && setting !== undefined) properties[name.trim().toLowerCase()] = setting.trim();
    } else if (kind === 'project') project.projectReferences.push(value);
  }
  return project;
}

/** A `Compile Remove` glob (`**`, `*`, `?`, relative to the project) as a test over project-relative paths. */
export function globMatcher(glob: string): (relative: string) => boolean {
  const source = glob
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  const pattern = new RegExp(`^${source}$`, 'i');
  return (relative) => pattern.test(relative);
}
