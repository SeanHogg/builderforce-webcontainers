/**
 * Generating `vendor/` 's autoloader for the installed packages and the root
 * package: PSR-4 and PSR-0 prefixes, class maps (scanned from the listed
 * directories for `class`/`interface`/`trait`/`enum` declarations), and
 * `files` (required on boot), plus `installed.json`/`installed.php` for
 * `Composer\InstalledVersions`. Paths in the maps are absolute PHP paths
 * built from `__DIR__`, so the project works wherever it is mounted.
 */
import { join } from '@seanhogg/builderforce-webcontainers-core';
import { AUTOLOAD_SOURCE, CLASS_LOADER_SOURCE, INSTALLED_VERSIONS_SOURCE } from './autoloadSource.js';
import type { Autoload, PackageVersion } from './packagist.js';

/** The file-system calls the installer makes (PHP paths). */
export interface ComposerFiles {
  read(path: string): string | undefined;
  write(path: string, content: string | Uint8Array): void;
  isDir(path: string): boolean;
  /** Every file under `dir`, recursively, as absolute paths. */
  list(dir: string): string[];
  remove(path: string): void;
}

/** A PHP literal for JSON-shaped data. */
export function phpLiteral(value: unknown, expression?: (text: string) => string | undefined): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return expression?.(value) ?? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map((item) => phpLiteral(item, expression)).join(', ')}]`;
  return `[${Object.entries(value as Record<string, unknown>).map(([key, item]) => `${phpLiteral(key)} => ${phpLiteral(item, expression)}`).join(', ')}]`;
}

const DECLARATION = /^\s*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)/gm;
const NAMESPACE = /^\s*namespace\s+([A-Za-z_\\][A-Za-z0-9_\\]*)\s*[;{]/m;

/** Class names a PHP file declares (namespace-qualified). */
export function declaredClasses(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|#).*$/gm, '');
  const namespace = NAMESPACE.exec(code)?.[1];
  return [...code.matchAll(DECLARATION)].map((match) => (namespace ? `${namespace}\\${match[2]}` : match[2]!));
}

interface Maps {
  psr4: Record<string, string[]>;
  psr0: Record<string, string[]>;
  classmap: Record<string, string>;
  files: string[];
}

/** One package's (or the root's) autoload rules, its paths under `dir` (a path relative to `vendor/`'s parent, or '' for the root). */
function addAutoload(maps: Maps, files: ComposerFiles, projectDir: string, dir: string, autoload: Autoload | undefined): void {
  if (!autoload) return;
  const at = (path: string) => join(projectDir, dir, path);
  for (const [prefix, paths] of Object.entries(autoload['psr-4'] ?? {})) (maps.psr4[prefix] ??= []).push(...[paths].flat().map(at));
  for (const [prefix, paths] of Object.entries(autoload['psr-0'] ?? {})) (maps.psr0[prefix] ??= []).push(...[paths].flat().map(at));
  for (const file of autoload.files ?? []) maps.files.push(at(file));
  const excluded = (autoload['exclude-from-classmap'] ?? []).map(at);
  for (const entry of autoload.classmap ?? []) {
    const target = at(entry);
    const candidates = files.isDir(target) ? files.list(target).filter((path) => /\.(php|inc|hh)$/.test(path)) : [target];
    for (const path of candidates) {
      if (excluded.some((prefix) => path.startsWith(prefix))) continue;
      for (const name of declaredClasses(files.read(path) ?? '')) maps.classmap[name] ??= path;
    }
  }
}

/** Rewrite absolute project paths in generated PHP as `$baseDir . '…'`, so the maps follow the project. */
const relativeTo = (projectDir: string) => (text: string) => (text === projectDir || text.startsWith(`${projectDir}/`) ? `$baseDir . ${phpLiteral(text.slice(projectDir.length))}` : undefined);

export interface RootPackage {
  name?: string;
  version?: string;
  autoload?: Autoload;
  'autoload-dev'?: Autoload;
}

/** `packages` with each one after the packages it requires (cycles broken by name order). */
export function dependencyOrder(packages: readonly PackageVersion[]): PackageVersion[] {
  const byName = new Map(packages.map((pkg) => [pkg.name.toLowerCase(), pkg]));
  const done = new Set<string>();
  const out: PackageVersion[] = [];
  const visit = (pkg: PackageVersion, path: Set<string>) => {
    const name = pkg.name.toLowerCase();
    if (done.has(name) || path.has(name)) return;
    path.add(name);
    for (const dep of Object.keys(pkg.require ?? {}).sort()) {
      const required = byName.get(dep.toLowerCase());
      if (required) visit(required, path);
    }
    path.delete(name);
    done.add(name);
    out.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg, new Set());
  return out;
}

/** Write vendor/autoload.php and vendor/composer/* for `installed` (paths: `projectDir` is the composer.json directory). */
export function writeAutoloader(files: ComposerFiles, projectDir: string, root: RootPackage, installed: readonly PackageVersion[], options: { dev: boolean; devPackages: ReadonlySet<string> }): void {
  // The root's PSR maps and classes win (added first); `files` load dependencies first and the root's last, as Composer orders them.
  const maps: Maps = { psr4: {}, psr0: {}, classmap: {}, files: [] };
  addAutoload(maps, files, projectDir, '', root.autoload);
  if (options.dev) addAutoload(maps, files, projectDir, '', root['autoload-dev']);
  const rootFiles = maps.files.splice(0);
  for (const pkg of dependencyOrder(installed)) addAutoload(maps, files, projectDir, `vendor/${pkg.name}`, pkg.autoload);
  maps.files.push(...rootFiles);
  const vendor = join(projectDir, 'vendor');
  const relative = relativeTo(projectDir);
  files.write(join(vendor, 'autoload.php'), AUTOLOAD_SOURCE);
  files.write(join(vendor, 'composer/ClassLoader.php'), CLASS_LOADER_SOURCE);
  files.write(join(vendor, 'composer/InstalledVersions.php'), INSTALLED_VERSIONS_SOURCE);
  files.write(join(vendor, 'composer/autoload_bfwc.php'), `<?php\n// Generated by the BuilderForce WebContainers PHP runtime.\n$baseDir = dirname(__DIR__, 2);\nreturn ${phpLiteral(maps, relative)};\n`);
  files.write(join(vendor, 'composer/installed.json'), `${JSON.stringify({ packages: installed, dev: options.dev, 'dev-package-names': [...options.devPackages] }, null, 4)}\n`);
  const versions = Object.fromEntries(
    installed.map((pkg) => [
      pkg.name,
      { pretty_version: pkg.version, version: pkg.version_normalized ?? pkg.version, reference: pkg.dist?.reference ?? pkg.source?.reference ?? null, type: pkg.type ?? 'library', install_path: join(vendor, pkg.name), aliases: [], dev_requirement: options.devPackages.has(pkg.name) },
    ]),
  );
  const rootEntry = { name: root.name ?? '__root__', pretty_version: root.version ?? 'dev-main', version: root.version ?? 'dev-main', reference: null, type: 'project', install_path: projectDir, aliases: [], dev: options.dev };
  files.write(join(vendor, 'composer/installed.php'), `<?php\n$baseDir = dirname(__DIR__, 2);\nreturn ${phpLiteral({ root: rootEntry, versions: { ...versions, [rootEntry.name]: { ...rootEntry, dev_requirement: false } } }, relative)};\n`);
}
