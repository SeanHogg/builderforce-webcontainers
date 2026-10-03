import type * as TS from 'typescript';
import { VirtualFileSystem, type FileSystemTree, type FlatFiles } from '../vfs.js';
import { readProjectConfig } from '../projectConfig.js';
import { isBareSpecifier, resolveAlias, splitPackageSpecifier } from '../resolve.js';
import { acquireExtendedConfigs, acquireTypes, type FetchLike } from './acquire.js';
import { createVirtualHost } from './compilerHost.js';
import { sortDiagnostics, toCheckDiagnostic, type CheckDiagnostic } from './diagnostics.js';
import { resolveCheckProjects, type CheckProject } from './projects.js';
import { AMBIENT_SHIM_PATH, ambientShim } from './shims.js';
import {
  DEFAULT_NPM_BASE_URL,
  DEFAULT_TYPES_ORIGIN,
  libBaseUrlFor,
  packageRequestUrl,
  TypeStore,
  type TypeSources,
} from './typeStore.js';

/**
 * `tsc --noEmit` over a project held in memory. Runtime-agnostic: the caller
 * passes the TypeScript module (the npm package in Node, the CDN build in a
 * worker) and a `fetch` for type definitions, so the same code is tested in Node
 * and run in the browser.
 */
export interface TypecheckOptions {
  fetch: FetchLike;
  /** Where types, libs and tsconfig packages come from. Libs default to jsDelivr at `ts.version`. */
  sources?: Partial<TypeSources>;
  /** Reuse fetched and parsed declarations across checks (a long-lived worker keeps one). */
  store?: TypeStore;
  /** Cap on fetched declaration files. Default 2000. */
  maxTypeFiles?: number;
}

export interface TypecheckResult {
  diagnostics: CheckDiagnostic[];
  /** Imported packages with no types on the CDN — checked as `any` rather than reported. */
  untypedPackages: string[];
  /** Project files that were checked, project-relative. */
  files: string[];
}

interface Reach {
  specifiers: Set<string>;
  typeReferences: Set<string>;
  libFiles: Set<string>;
}

function toFileSystem(files: VirtualFileSystem | FlatFiles | FileSystemTree): VirtualFileSystem {
  if (files instanceof VirtualFileSystem) return files;
  const fs = new VirtualFileSystem();
  fs.mount(files);
  return fs;
}

/** Everything a set of programs can reach outside the project: packages, type references, libs. */
function collectReach(ts: typeof TS, fs: VirtualFileSystem, projects: CheckProject[], isAliased: (spec: string) => boolean): Reach {
  const reach: Reach = { specifiers: new Set(), typeReferences: new Set(), libFiles: new Set() };
  for (const project of projects) {
    const { options } = project;
    for (const path of project.rootNames) {
      const info = ts.preProcessFile(fs.readText(path) ?? '', true, true);
      for (const ref of info.importedFiles) {
        if (isBareSpecifier(ref.fileName) && !ref.fileName.includes('?') && !isAliased(ref.fileName)) reach.specifiers.add(ref.fileName);
      }
      for (const ref of info.typeReferenceDirectives) reach.typeReferences.add(ref.fileName);
      for (const ref of info.libReferenceDirectives) reach.libFiles.add(`lib.${ref.fileName.toLowerCase()}.d.ts`);
    }
    for (const name of options.types ?? []) reach.typeReferences.add(name);
    if (options.jsx === ts.JsxEmit.ReactJSX || options.jsx === ts.JsxEmit.ReactJSXDev) {
      const runtime = options.jsx === ts.JsxEmit.ReactJSXDev ? 'jsx-dev-runtime' : 'jsx-runtime';
      reach.specifiers.add(`${options.jsxImportSource ?? 'react'}/${runtime}`);
    }
    if (!options.noLib) for (const lib of options.lib ?? [ts.getDefaultLibFileName(options)]) reach.libFiles.add(lib);
  }
  return reach;
}

export async function typecheckProject(
  ts: typeof TS,
  files: VirtualFileSystem | FlatFiles | FileSystemTree,
  options: TypecheckOptions,
): Promise<TypecheckResult> {
  const fs = toFileSystem(files);
  const store = options.store ?? new TypeStore();
  const sources: TypeSources = {
    typesOrigin: DEFAULT_TYPES_ORIGIN,
    npmBaseUrl: DEFAULT_NPM_BASE_URL,
    libBaseUrl: libBaseUrlFor(ts.version),
    ...options.sources,
  };
  const config = readProjectConfig(fs);
  const { dependencies } = config;

  await acquireExtendedConfigs(fs, store, dependencies, { fetch: options.fetch, sources });
  const projects = resolveCheckProjects(ts, fs, store, config.jsx.importSource === 'react' ? undefined : config.jsx.importSource);
  const reach = collectReach(ts, fs, projects, (spec) => resolveAlias(fs, config.aliases, spec) !== undefined);
  await acquireTypes(
    ts,
    store,
    { specifiers: [...reach.specifiers], typeReferences: [...reach.typeReferences], libFiles: [...reach.libFiles], dependencies },
    { fetch: options.fetch, sources, maxFiles: options.maxTypeFiles ?? 2000 },
  );

  const untypedPackages = [
    ...new Set(
      [...reach.specifiers]
        .filter((spec) => !store.packages.get(packageRequestUrl(sources.typesOrigin, spec, dependencies)))
        .map((spec) => splitPackageSpecifier(spec).name),
    ),
  ].sort();
  const projectDeclarations = fs.list().filter((path) => path.endsWith('.d.ts')).map((path) => fs.readText(path) ?? '');
  const shim = ambientShim({ existing: [...projectDeclarations, ...store.files.values()], untyped: untypedPackages });

  const diagnostics: CheckDiagnostic[] = [];
  const checked = new Set<string>();
  for (const project of projects) {
    for (const error of project.errors) diagnostics.push(toCheckDiagnostic(ts, error));
    if (!project.rootNames.length) continue;
    const host = createVirtualHost(ts, { fs, store, typesOrigin: sources.typesOrigin, dependencies, aliases: config.aliases, shim });
    const program = ts.createProgram({ rootNames: [...project.rootNames, AMBIENT_SHIM_PATH], options: project.options, host });
    const found = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
    for (const file of program.getSourceFiles()) {
      if (!fs.isFile(file.fileName)) continue; // libs, package types, shims
      checked.add(file.fileName.slice(1));
      found.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
    }
    for (const diagnostic of found) {
      if (diagnostic.file && !fs.isFile(diagnostic.file.fileName)) continue;
      diagnostics.push(toCheckDiagnostic(ts, diagnostic));
    }
  }
  return { diagnostics: sortDiagnostics(diagnostics), untypedPackages, files: [...checked].sort() };
}
