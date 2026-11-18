/**
 * Reading a .NET project as the browser runtime builds it: an SDK-style
 * `.csproj` (its SDK, properties, package/project/framework references,
 * `<Using>` items and `<Compile Remove>` globs), or a file-based program's
 * directives (`#:sdk`, `#:package`, `#:property`, .NET 10's `dotnet run
 * app.cs`). A light scan, not MSBuild: conditions are evaluated when they
 * compare `$(Configuration)`, `$(Platform)`, `$(TargetFramework)` or `$(OS)`
 * with `==`/`!=` (joined by `and`/`or`); anything else counts as false.
 * `<Choose>` takes its first `<When>` that holds, else `<Otherwise>`.
 * Imports and Directory.Build.props are not read.
 *
 * What the scan would get wrong is refused (thrown, with the reason) rather
 * than built differently: `EnableDefaultCompileItems=false`, `<Compile
 * Include>` outside the project, and properties or items set inside a
 * `<Target>` (they apply when the target runs, which no build here does).
 *
 * The XML is read by one linear pass (no backtracking regular expressions), so
 * a malformed or hostile project file costs time in proportion to its size.
 */
import { basename, dirname, resolveFrom } from '@seanhogg/builderforce-webcontainers-core';

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

/** An element as the scan reads it: its name, attributes (lower-cased names), child elements and direct text. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r';
const isNameChar = (char: string) => /[\w:.-]/.test(char);

/** The attributes of a start tag's body (after its name): `name="value"` / `name='value'`, one pass. */
function attributesOf(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && !isNameChar(body[i]!)) i++;
    const start = i;
    while (i < body.length && isNameChar(body[i]!)) i++;
    const name = body.slice(start, i);
    while (i < body.length && isSpace(body[i]!)) i++;
    if (!name || body[i] !== '=') continue;
    i++;
    while (i < body.length && isSpace(body[i]!)) i++;
    const quote = body[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = body.indexOf(quote, i + 1);
    if (end < 0) break;
    found[name.toLowerCase()] = decode(body.slice(i + 1, end));
    i = end + 1;
  }
  return found;
}

/** The end of a start tag beginning at `from` (its `>`, outside quoted values), or -1. */
function tagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let i = from; i < text.length; i++) {
    const char = text[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

/** Parse XML leniently in one pass: comments, processing instructions and doctypes skipped, CDATA as text, unclosed elements closed at the end. */
export function parseXml(text: string): XmlElement {
  const document: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [document];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    const current = stack[stack.length - 1]!;
    if (open < 0) {
      current.text += decode(text.slice(i));
      break;
    }
    current.text += decode(text.slice(i, open));
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      current.text += text.slice(open + 9, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith('</', open)) {
      const end = text.indexOf('>', open + 2);
      const name = text.slice(open + 2, end < 0 ? text.length : end).trim().toLowerCase();
      // Close up to the matching element; a stray end tag closes nothing.
      for (let at = stack.length - 1; at > 0; at--) {
        if (stack[at]!.name.toLowerCase() !== name) continue;
        stack.length = at;
        break;
      }
      i = end < 0 ? text.length : end + 1;
    } else {
      const end = tagEnd(text, open + 1);
      if (end < 0) break;
      let body = text.slice(open + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      let nameEnd = 0;
      while (nameEnd < body.length && isNameChar(body[nameEnd]!)) nameEnd++;
      const element: XmlElement = { name: body.slice(0, nameEnd), attrs: attributesOf(body.slice(nameEnd)), children: [], text: '' };
      current.children.push(element);
      if (!selfClosing && element.name) stack.push(element);
      i = end + 1;
    }
  }
  return document;
}

const named = (element: XmlElement, name: string) => element.name.toLowerCase() === name.toLowerCase();
const childrenNamed = (element: XmlElement, name: string) => element.children.filter((child) => named(child, name));
const valueOf = (element: XmlElement) => element.text.trim();
const hasDescendant = (element: XmlElement, names: readonly string[]): boolean => element.children.some((child) => names.some((name) => named(child, name)) || hasDescendant(child, names));

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

const withoutVersion = (sdk: string) => sdk.split('/')[0]!.trim();
const splitList = (value: string) => value.split(';').map((entry) => entry.trim()).filter(Boolean);

/**
 * The project's property and item groups in document order, `<Choose>` resolved
 * against the properties known when it is reached (as MSBuild's property pass
 * does). `visit` receives each group that applies.
 */
function walkGroups(parent: XmlElement, holds: (attrs: Record<string, string>) => boolean, visit: (group: XmlElement) => void): void {
  for (const child of parent.children) {
    if (named(child, 'PropertyGroup') || named(child, 'ItemGroup')) {
      if (holds(child.attrs)) visit(child);
    } else if (named(child, 'Choose')) {
      const branch = childrenNamed(child, 'When').find((when) => holds(when.attrs)) ?? childrenNamed(child, 'Otherwise')[0];
      if (branch) walkGroups(branch, holds, visit);
    }
  }
}

/** Parse a `.csproj` for `configuration`. Throws on what is not an SDK-style project, or what the scan cannot build faithfully. */
export function parseProjectFile(text: string, path: string, configuration: string): ProjectFile {
  const name = basename(path);
  const root = parseXml(text).children.find((element) => named(element, 'Project'));
  if (!root) throw new Error(`${name} is not an MSBuild project (no <Project> element).`);
  const sdk = root.attrs.sdk ?? childrenNamed(root, 'Sdk')[0]?.attrs.name ?? childrenNamed(root, 'Import').find((element) => element.attrs.sdk)?.attrs.sdk;
  if (!sdk) throw new Error(`${name} is not an SDK-style project (no Sdk attribute): the browser runtime builds SDK-style projects only.`);
  if (childrenNamed(root, 'Target').some((target) => hasDescendant(target, ['PropertyGroup', 'ItemGroup']))) {
    throw new Error(`${name} sets properties or items inside a <Target>: the browser runtime does not run MSBuild targets, so it cannot build this project as MSBuild would.`);
  }
  const dir = dirname(path);
  const properties: Record<string, string> = {
    configuration,
    platform: 'AnyCPU',
    os: 'Unix',
    msbuildprojectname: name.replace(/\.\w+proj$/i, ''),
    msbuildprojectdirectory: dir,
  };
  const holds = (attrs: Record<string, string>) => attrs.condition === undefined || evaluateCondition(attrs.condition, properties);

  walkGroups(root, holds, (group) => {
    if (!named(group, 'PropertyGroup')) return;
    for (const property of group.children) {
      if (property.name && holds(property.attrs)) properties[property.name.toLowerCase()] = expandProperties(valueOf(property), properties);
    }
  });
  // Conditions on items may name the target framework, known only now.
  properties.targetframework ??= (properties.targetframeworks ?? '').split(';')[0]?.trim() ?? '';
  if ((properties.enabledefaultcompileitems ?? '').trim().toLowerCase() === 'false') {
    throw new Error(`${name} sets EnableDefaultCompileItems to false: the browser runtime compiles every .cs file under the project (less <Compile Remove>), so it cannot build an explicit source list.`);
  }

  const project: ProjectFile = { path, dir, sdk: withoutVersion(sdk), properties, packages: [], projectReferences: [], frameworkReferences: [], usings: [], compileRemove: [], fileBased: false };
  walkGroups(root, holds, (group) => {
    if (!named(group, 'ItemGroup')) return;
    for (const item of group.children) {
      if (!item.name || !holds(item.attrs)) continue;
      const include = expandProperties(item.attrs.include ?? item.attrs.update ?? '', properties);
      switch (item.name.toLowerCase()) {
        case 'packagereference': {
          if (!item.attrs.include) break; // `Update` only changes a reference made elsewhere
          const nested = Object.fromEntries(item.children.map((child) => [child.name.toLowerCase(), valueOf(child)]));
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
          if (item.attrs.remove) project.compileRemove.push(...splitList(expandProperties(item.attrs.remove, properties)));
          if (item.attrs.include) {
            const outside = splitList(include).filter((entry) => {
              const target = resolveFrom(dir, entry.replace(/\\/g, '/'));
              return target !== dir && !target.startsWith(dir === '/' ? '/' : `${dir}/`);
            });
            if (outside.length) throw new Error(`${name} compiles files outside its project (<Compile Include="${outside.join(';')}">): the browser runtime builds one project's own sources.`);
          }
          break;
      }
    }
  });
  return project;
}

/**
 * A file-based program (`app.cs`): an executable with implicit usings and
 * nullable enabled (.NET 10's defaults), shaped by its `#:sdk`, `#:package
 * Name@Version` and `#:property Name=Value` directives. As .NET reads them,
 * directives are only those at the top of the file — after an optional `#!`
 * line, among blank and `//` comment lines — and reading stops at the first
 * other line. `#:project` is refused (thrown), as project references are.
 */
export function parseFileBasedProgram(text: string, path: string): ProjectFile {
  const properties: Record<string, string> = { outputtype: 'Exe', implicitusings: 'enable', nullable: 'enable', targetframework: 'net10.0' };
  const project: ProjectFile = { path, dir: dirname(path), sdk: 'Microsoft.NET.Sdk', properties, packages: [], projectReferences: [], frameworkReferences: [], usings: [], compileRemove: [], fileBased: true };
  for (const directive of runDirectives(text)) {
    const { kind, value } = directive;
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

/** A file-based program's leading `#:` directives (the host program blanks the same lines before compiling). */
export function runDirectives(text: string): Array<{ line: number; kind: string; value: string }> {
  const found: Array<{ line: number; kind: string; value: string }> = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\r$/, '').trim();
    if (index === 0 && line.startsWith('#!')) continue;
    if (!line || line.startsWith('//')) continue;
    if (!line.startsWith('#:')) break;
    const directive = /^#:(\w+)\s+(.+?)\s*$/.exec(line);
    if (directive) found.push({ line: index, kind: directive[1]!, value: directive[2]! });
  }
  return found;
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
