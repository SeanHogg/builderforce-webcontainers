/**
 * `npm install` into the virtual file system: read package.json, resolve the
 * tree (lockfile first, registry second), prune what is no longer wanted, unpack
 * what is missing, link `.bin`, write package-lock.json.
 *
 * Install scripts (`preinstall`/`install`/`postinstall`) are NOT run. Nearly all
 * of them compile native addons (node-gyp) or download platform binaries, neither
 * of which can work in a browser; running the rest would mean executing arbitrary
 * package code at install time for little gain. Packages that declare them are
 * reported in `warnings`.
 */
import { gunzipSync } from 'fflate';
import type { VirtualFileSystem } from '../vfs.js';
import { join } from '../paths.js';
import { RegistryClient, type FetchLike, type PackageCache, type PackageManifest, type Packument } from './registry.js';
import { parseInstallSpec, sortObject, type PackageJson, type ParsedSpec } from './spec.js';
import { childLocation, parentLocation, resolveTree, type ResolvedPackage } from './tree.js';
import { buildLockfile, lockMatchesPackage, lockedManifests, parseLockfile, pickLocked, type Lockfile } from './lockfile.js';
import { maxSatisfying, satisfies, validRange, valid } from './semver.js';
import { untar } from './tar.js';
import { linkBins } from './bins.js';

export interface InstallProgress {
  phase: 'resolve' | 'fetch' | 'done';
  /** `name@version` being worked on. */
  package?: string;
  done: number;
  total: number;
}

export interface InstallOptions {
  fs: VirtualFileSystem;
  fetch: FetchLike;
  registry?: string;
  cache?: PackageCache;
  /** The project directory holding package.json. Default `/`. */
  cwd?: string;
  /** Specs to add first, as `npm install <spec…>` does (`react`, `zod@^3`, `@scope/x@next`). */
  add?: string[];
  /** Save added specs to devDependencies. */
  saveDev?: boolean;
  /** `npm ci`: install exactly what the lockfile says; fail when it is missing or stale. */
  ci?: boolean;
  /** Leave devDependencies out. */
  production?: boolean;
  /** Parallel downloads. Default 8. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?(progress: InstallProgress): void;
}

export interface InstallResult {
  /** Packages unpacked this run. */
  added: number;
  /** Packages removed (no longer in the tree, or replaced by another version). */
  removed: number;
  /** Packages in the tree. */
  total: number;
  /** Top-level bins: name → absolute path of the script. */
  bins: Record<string, string>;
  lockfile: Lockfile;
  warnings: string[];
}

const fatalDecoder = new TextDecoder('utf-8', { fatal: true });
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|bmp|wasm|node|gz|tgz|zip|br|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav|bin|dat)$/i;

/** Store text as strings (what the module loader reads), binaries as bytes. */
function decodeIfText(path: string, data: Uint8Array): string | Uint8Array {
  if (BINARY_EXT.test(path)) return data.slice();
  const head = data.subarray(0, 8000);
  if (head.includes(0)) return data.slice();
  try {
    return fatalDecoder.decode(data);
  } catch {
    return data.slice();
  }
}

/** Highest version allowed by `range` (or a dist-tag), preferring `latest` as npm does. */
export function chooseVersion(packument: Packument, range: string): string {
  const tags = packument['dist-tags'] ?? {};
  const r = range || '*';
  if (!validRange(r)) {
    const tagged = tags[r];
    if (tagged && packument.versions[tagged]) return tagged;
    throw new Error(`No version of ${packument.name} is tagged "${range}".`);
  }
  const latest = tags.latest;
  if (latest && packument.versions[latest] && satisfies(latest, r)) return latest;
  const best = maxSatisfying(Object.keys(packument.versions), r);
  if (!best) throw new Error(`No matching version found for ${packument.name}@${range}.`);
  return best;
}

async function pool<T>(items: T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  });
  await Promise.all(workers);
}

function readJson<T>(fs: VirtualFileSystem, path: string): T | undefined {
  try {
    const text = fs.readText(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  } catch {
    return undefined;
  }
}

const writeJson = (fs: VirtualFileSystem, path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value, null, 2) + '\n');

/** What is on disk now: location → `name@version`. */
function installedPackages(fs: VirtualFileSystem, base: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (loc: string) => {
    const nm = join(base, loc, 'node_modules');
    const names: string[] = [];
    for (const entry of fs.readdir(nm)) {
      if (entry.startsWith('.')) continue;
      if (entry.startsWith('@')) for (const sub of fs.readdir(join(nm, entry))) names.push(`${entry}/${sub}`);
      else names.push(entry);
    }
    for (const name of names) {
      const at = childLocation(loc, name);
      const pkg = readJson<PackageJson>(fs, join(base, at, 'package.json'));
      out.set(at, `${pkg?.name ?? ''}@${pkg?.version ?? ''}`);
      walk(at);
    }
  };
  walk('');
  return out;
}

async function addSpecs(client: RegistryClient, pkg: PackageJson, specs: string[], dev: boolean): Promise<void> {
  const save = dev ? 'devDependencies' : 'dependencies';
  const other = dev ? 'dependencies' : 'devDependencies';
  for (const raw of specs) {
    const spec: ParsedSpec = parseInstallSpec(raw);
    let saved = spec.range;
    if (!saved || !validRange(saved)) saved = `^${chooseVersion(await client.packument(spec.registryName), saved || 'latest')}`;
    else if (valid(saved)) saved = `^${valid(saved)}`;
    if (spec.registryName !== spec.name) saved = `npm:${spec.registryName}@${saved}`;
    pkg[save] = sortObject({ ...(pkg[save] ?? {}), [spec.name]: saved });
    if (pkg[other]?.[spec.name]) {
      const rest = { ...pkg[other] };
      delete rest[spec.name];
      pkg[other] = rest;
    }
  }
}

export async function installPackages(options: InstallOptions): Promise<InstallResult> {
  const { fs, signal } = options;
  const base = join('/', options.cwd ?? '/');
  const pkgPath = join(base, 'package.json');
  const lockPath = join(base, 'package-lock.json');
  const warnings: string[] = [];
  const client = new RegistryClient({ fetch: options.fetch, registry: options.registry, cache: options.cache, signal });
  const progress = (p: InstallProgress) => options.onProgress?.(p);

  let pkg = readJson<PackageJson>(fs, pkgPath);
  if (!pkg) {
    if (fs.isFile(pkgPath)) throw new Error(`${pkgPath} is not valid JSON.`);
    if (!options.add?.length) throw new Error(`No package.json in ${base}.`);
    pkg = {};
  }
  if (options.add?.length) {
    await addSpecs(client, pkg, options.add, options.saveDev ?? false);
    writeJson(fs, pkgPath, pkg);
  }

  const lock = parseLockfile(fs.readText(lockPath));
  if (options.ci) {
    if (!lock) throw new Error('npm ci needs a package-lock.json (lockfileVersion 2 or 3).');
    if (!lockMatchesPackage(lock, pkg)) throw new Error('package.json and package-lock.json are out of sync. Run npm install to update the lockfile.');
    fs.rm(join(base, 'node_modules'));
  }
  const locked = lockedManifests(lock);

  const picks = new Map<string, Promise<PackageManifest>>();
  const pick = (spec: ParsedSpec): Promise<PackageManifest> => {
    const key = `${spec.registryName}@${spec.range}`;
    let pending = picks.get(key);
    if (!pending) {
      const hit = pickLocked(locked, spec.registryName, spec.range);
      if (hit) pending = Promise.resolve(hit);
      else if (options.ci) pending = Promise.reject(new Error(`${key} is missing from package-lock.json. Run npm install to update it.`));
      else pending = client.packument(spec.registryName).then((p) => {
        const manifest = p.versions[chooseVersion(p, spec.range)]!;
        return { ...manifest, name: manifest.name ?? spec.registryName };
      });
      pending.catch(() => undefined); // observed by whoever awaits it
      picks.set(key, pending);
    }
    return pending;
  };

  let resolved = 0;
  const tree = await resolveTree({
    root: pkg,
    pick,
    prefetch: (spec) => void (pickLocked(locked, spec.registryName, spec.range) || options.ci || client.packument(spec.registryName).catch(() => undefined)),
    production: options.production,
    warn: (message) => warnings.push(message),
    onResolved: ({ name, version }) => progress({ phase: 'resolve', package: `${name}@${version}`, done: ++resolved, total: resolved }),
  });
  signal?.throwIfAborted();

  // Prune: anything not in the tree, or there at another version, goes (shallow first).
  let removed = 0;
  for (const [location, id] of [...installedPackages(fs, base)].sort(([a], [b]) => a.length - b.length)) {
    const dir = join(base, location);
    if (!fs.exists(dir)) continue; // went with an enclosing package
    const want = tree.get(location);
    if (!want || id !== `${want.manifest.name}@${want.manifest.version}`) {
      fs.rm(dir);
      removed++;
    }
  }

  const missing = [...tree.values()].filter((node) => !fs.isFile(join(base, node.location, 'package.json')));
  let fetched = 0;
  await pool(missing, options.concurrency ?? 8, async (node) => {
    signal?.throwIfAborted();
    await unpack(fs, join(base, node.location), await client.tarball(node.manifest));
    progress({ phase: 'fetch', package: `${node.name}@${node.manifest.version}`, done: ++fetched, total: missing.length });
  });

  for (const node of tree.values()) {
    if (node.manifest.hasInstallScript) warnings.push(`skipped install scripts of ${node.name}@${node.manifest.version} (they cannot run in the browser)`);
    if (node.manifest.deprecated) warnings.push(`deprecated ${node.name}@${node.manifest.version}: ${node.manifest.deprecated}`);
  }

  const bins = relinkBins(fs, base, tree);
  const lockfile = buildLockfile(pkg, tree);
  writeJson(fs, lockPath, lockfile);
  progress({ phase: 'done', done: tree.size, total: tree.size });
  return { added: missing.length, removed, total: tree.size, bins, lockfile, warnings };
}

/** gunzip + untar into `dir`, stripping the archive's top folder (`package/`). */
async function unpack(fs: VirtualFileSystem, dir: string, tgz: Uint8Array): Promise<void> {
  const entries = untar(gunzipSync(tgz));
  let manifest: Uint8Array | undefined;
  for (const entry of entries) {
    if (entry.type !== 'file') continue;
    const relative = entry.path.split('/').slice(1).join('/');
    if (!relative || relative.split('/').includes('..')) continue;
    // package.json goes last: its presence is what marks the package as installed.
    if (relative === 'package.json') manifest = entry.data;
    else fs.writeFile(join(dir, relative), decodeIfText(relative, entry.data));
  }
  if (!manifest) throw new Error(`The tarball for ${dir} has no package.json.`);
  fs.writeFile(join(dir, 'package.json'), decodeIfText('package.json', manifest));
}

/** Rebuild every `.bin` directory from the tree; returns the top-level bins. */
function relinkBins(fs: VirtualFileSystem, base: string, tree: Map<string, ResolvedPackage>): Record<string, string> {
  const groups = new Map<string, ResolvedPackage[]>();
  for (const node of tree.values()) {
    const parent = parentLocation(node.location);
    groups.set(parent, [...(groups.get(parent) ?? []), node]);
  }
  fs.rm(join(base, 'node_modules/.bin'));
  let top: Record<string, string> = {};
  for (const [parent, nodes] of groups) {
    const binDir = join(base, parent, 'node_modules/.bin');
    const linked = linkBins(fs, binDir, nodes.map((n) => ({ dir: join(base, n.location), name: n.name, bin: readJson<PackageJson>(fs, join(base, n.location, 'package.json'))?.bin ?? n.manifest.bin })));
    if (parent === '') top = linked;
  }
  return top;
}
