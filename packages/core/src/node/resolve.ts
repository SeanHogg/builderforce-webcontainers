/**
 * Node's module resolution over the VFS: builtins (`fs`, `node:fs`), relative and
 * absolute paths with extension and directory probing, `node_modules` lookup up
 * the tree, package.json `main`, `exports` (conditions, subpath patterns, arrays,
 * `null` exclusions), `imports` (`#internal`) and package self-reference.
 *
 * Distinct from ../resolve.ts, which resolves the way Vite does for the preview.
 */
import type { VirtualFileSystem } from '../vfs.js';
import { dirname, join, normalizePath } from '../paths.js';
import { splitPackageSpecifier } from '../resolve.js';

/** Conditions `require()` matches; `import` swaps `require` for `import`. */
export const REQUIRE_CONDITIONS = ['node', 'require', 'default'] as const;
export const IMPORT_CONDITIONS = ['node', 'import', 'default'] as const;

const EXTENSIONS = ['.js', '.json', '.cjs', '.mjs', '.node'];

export type Resolution = { builtin: string } | { path: string };

interface PackageJsonLike {
  name?: string;
  main?: string;
  type?: string;
  exports?: unknown;
  imports?: unknown;
}

export function moduleNotFound(request: string, from?: string): Error {
  const error = new Error(`Cannot find module '${request}'${from ? `\nRequire stack:\n- ${from}` : ''}`) as Error & { code: string; requireStack?: string[] };
  error.code = 'MODULE_NOT_FOUND';
  if (from) error.requireStack = [from];
  return error;
}

function readPackageJson(fs: VirtualFileSystem, dir: string): PackageJsonLike | undefined {
  const text = fs.readText(join(dir, 'package.json'));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as PackageJsonLike;
  } catch {
    return undefined;
  }
}

/** The nearest package.json at or above `dir`: its directory and contents. */
export function findPackageScope(fs: VirtualFileSystem, dir: string): { dir: string; pkg: PackageJsonLike } | undefined {
  for (let current = normalizePath(dir); ; current = dirname(current)) {
    if (!current.endsWith('/node_modules')) {
      const pkg = readPackageJson(fs, current);
      if (pkg) return { dir: current, pkg };
    }
    if (current === '/') return undefined;
  }
}

function loadAsFile(fs: VirtualFileSystem, path: string): string | undefined {
  if (fs.isFile(path)) return path;
  for (const ext of EXTENSIONS) if (fs.isFile(path + ext)) return path + ext;
  return undefined;
}

function loadIndex(fs: VirtualFileSystem, dir: string): string | undefined {
  for (const ext of EXTENSIONS) if (fs.isFile(join(dir, 'index' + ext))) return join(dir, 'index' + ext);
  return undefined;
}

function loadAsDirectory(fs: VirtualFileSystem, dir: string): string | undefined {
  if (!fs.isDirectory(dir)) return undefined;
  const main = readPackageJson(fs, dir)?.main;
  if (typeof main === 'string' && main) {
    const target = join(dir, main);
    const hit = loadAsFile(fs, target) ?? loadIndex(fs, target);
    if (hit) return hit;
  }
  return loadIndex(fs, dir);
}

function loadPath(fs: VirtualFileSystem, path: string): string | undefined {
  return loadAsFile(fs, path) ?? loadAsDirectory(fs, path);
}

/** Resolve one exports/imports target against `conditions`. `null` = explicitly excluded. */
function resolveTarget(target: unknown, match: string, conditions: readonly string[]): string | null | undefined {
  if (typeof target === 'string') return target.replace(/\*/g, match);
  if (Array.isArray(target)) {
    for (const item of target) {
      const hit = resolveTarget(item, match, conditions);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (target && typeof target === 'object') {
    for (const [key, value] of Object.entries(target)) {
      if (key !== 'default' && !conditions.includes(key)) continue;
      const hit = resolveTarget(value, match, conditions);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  return target === null ? null : undefined;
}

/** Match `subpath` (`.`, `./feature`, `#dep`) in an exports/imports map. */
export function resolveMap(map: unknown, subpath: string, conditions: readonly string[]): string | null | undefined {
  const isSugar = typeof map === 'string' || Array.isArray(map) || (map && typeof map === 'object' && !Object.keys(map).some((k) => k.startsWith('.') || k.startsWith('#')));
  const record = (isSugar ? { '.': map } : map) as Record<string, unknown>;
  if (!record || typeof record !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(record, subpath) && !subpath.includes('*')) return resolveTarget(record[subpath], '', conditions);

  let best: { key: string; match: string } | undefined;
  for (const key of Object.keys(record)) {
    const star = key.indexOf('*');
    if (star >= 0) {
      const prefix = key.slice(0, star);
      const suffix = key.slice(star + 1);
      if (subpath.startsWith(prefix) && subpath.length >= key.length - 1 && subpath.endsWith(suffix) && (!best || prefix.length > best.key.indexOf('*'))) {
        best = { key, match: subpath.slice(prefix.length, subpath.length - suffix.length) };
      }
    } else if (key.endsWith('/') && subpath.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, match: '' }; // legacy folder mapping
    }
  }
  if (!best) return undefined;
  const resolved = resolveTarget(record[best.key], best.match, conditions);
  if (resolved && best.key.endsWith('/') && !best.key.includes('*')) return resolved + subpath.slice(best.key.length);
  return resolved;
}

function exportsError(name: string, subpath: string): Error {
  const error = new Error(`Package subpath '${subpath}' is not defined by "exports" in /node_modules/${name}/package.json`) as Error & { code: string };
  error.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  return error;
}

function resolvePackage(fs: VirtualFileSystem, pkgDir: string, name: string, subpath: string, conditions: readonly string[], request: string, from?: string): string {
  const pkg = readPackageJson(fs, pkgDir);
  if (pkg?.exports !== undefined && pkg.exports !== null) {
    const key = subpath ? `.${subpath}` : '.';
    const target = resolveMap(pkg.exports, key, conditions);
    if (!target) throw exportsError(name, key);
    const file = join(pkgDir, target);
    if (fs.isFile(file)) return file;
    throw moduleNotFound(request, from);
  }
  const hit = loadPath(fs, join(pkgDir, subpath || '.'));
  if (!hit) throw moduleNotFound(request, from);
  return hit;
}

export interface NodeResolveOptions {
  conditions: readonly string[];
  isBuiltin(name: string): boolean;
  /** The requiring file, for "Require stack" in errors. */
  from?: string;
  /** Extra lookup roots (`require.resolve(x, { paths })`). */
  paths?: string[];
}

export function resolveNodeModule(fs: VirtualFileSystem, request: string, fromDir: string, options: NodeResolveOptions): Resolution {
  const { conditions, from } = options;
  if (request.startsWith('node:')) {
    const name = request.slice(5);
    if (!options.isBuiltin(name)) throw Object.assign(new Error(`No such built-in module: ${request}`), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    return { builtin: name };
  }
  if (options.isBuiltin(request)) return { builtin: request };

  if (request.startsWith('#')) {
    const scope = findPackageScope(fs, fromDir);
    const target = scope?.pkg.imports ? resolveMap(scope.pkg.imports, request, conditions) : undefined;
    if (!target || !scope) throw Object.assign(new Error(`Package import specifier "${request}" is not defined${scope ? ` in package ${scope.dir}/package.json` : ''}`), { code: 'ERR_PACKAGE_IMPORT_NOT_DEFINED' });
    if (!target.startsWith('./')) return resolveNodeModule(fs, target, scope.dir, options);
    const file = join(scope.dir, target);
    if (fs.isFile(file)) return { path: file };
    throw moduleNotFound(request, from);
  }

  if (request === '.' || request === '..' || request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
    const base = request.startsWith('/') ? normalizePath(request) : join(fromDir, request);
    const hit = request.endsWith('/') ? loadAsDirectory(fs, base) : loadPath(fs, base);
    if (!hit) throw moduleNotFound(request, from);
    return { path: hit };
  }

  const { name, subpath } = splitPackageSpecifier(request);
  // Self-reference: a package importing itself by name through its own "exports".
  const scope = findPackageScope(fs, fromDir);
  if (scope?.pkg.name === name && scope.pkg.exports !== undefined) {
    return { path: resolvePackage(fs, scope.dir, name, subpath, conditions, request, from) };
  }
  const roots = options.paths ?? [];
  const lookup: string[] = [];
  for (let dir = normalizePath(fromDir); ; dir = dirname(dir)) {
    if (!dir.endsWith('/node_modules')) lookup.push(join(dir, 'node_modules'));
    if (dir === '/') break;
  }
  for (const root of roots) lookup.push(root.endsWith('node_modules') ? root : join(root, 'node_modules'));
  for (const nm of lookup) {
    const pkgDir = join(nm, name);
    if (fs.isDirectory(pkgDir) || fs.isFile(pkgDir + '.js') || fs.isFile(pkgDir + '.json')) {
      if (!fs.isDirectory(pkgDir)) return { path: loadAsFile(fs, pkgDir)! };
      return { path: resolvePackage(fs, pkgDir, name, subpath, conditions, request, from) };
    }
  }
  throw moduleNotFound(request, from);
}

/** `module.paths` for a directory: every enclosing node_modules. */
export function nodeModulePaths(fromDir: string): string[] {
  const out: string[] = [];
  for (let dir = normalizePath(fromDir); ; dir = dirname(dir)) {
    if (!dir.endsWith('/node_modules')) out.push(join(dir, 'node_modules'));
    if (dir === '/') return out;
  }
}
