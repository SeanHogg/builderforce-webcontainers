/**
 * Dependency tree resolution with npm-style hoisting.
 *
 * Breadth-first from the root, each dependency edge is first satisfied by
 * whatever Node's own lookup would find (walking up `node_modules`); only when
 * that fails is a version picked and PLACED — as high as possible without
 * (a) landing on a different version already there, or (b) shadowing a version
 * that some deeper package already resolves to and would stop satisfying. That
 * is what dedupes compatible versions to the top and nests conflicts.
 *
 * Locations are npm lockfile keys: `node_modules/a/node_modules/b`; the root is `''`.
 */
import type { PackageManifest } from './registry.js';
import { parseDependency, type PackageJson, type ParsedSpec } from './spec.js';
import { satisfies, validRange } from './semver.js';

export type EdgeType = 'prod' | 'dev' | 'optional' | 'peer';

export interface ResolvedPackage {
  location: string;
  /** The name it is installed under (an alias may differ from `manifest.name`). */
  name: string;
  manifest: PackageManifest;
  /** Only reachable through devDependencies. */
  dev: boolean;
  /** Only reachable through optionalDependencies. */
  optional: boolean;
}

interface Dependency {
  name: string;
  range: string;
  type: EdgeType;
}

interface Edge extends Dependency {
  /** The package that declared it (`''` for the root). */
  owner: string;
  /** Where lookup starts: the owner, or the owner's parent for a peer. */
  from: string;
  /** The location it resolved to. */
  to: string;
}

export interface ResolveTreeOptions {
  root: PackageJson;
  /** Choose a manifest for a spec (lockfile first, then the registry). */
  pick(spec: ParsedSpec): Promise<PackageManifest>;
  /** Warm caches for a spec about to be picked; lets fetches overlap. */
  prefetch?(spec: ParsedSpec): void;
  /** Leave devDependencies out (`--omit=dev`). */
  production?: boolean;
  warn(message: string): void;
  onResolved?(pkg: { name: string; version: string }): void;
}

export const childLocation = (loc: string, name: string): string => (loc ? `${loc}/node_modules/${name}` : `node_modules/${name}`);

export function parentLocation(location: string): string {
  const cut = location.lastIndexOf('/node_modules/');
  return cut < 0 ? '' : location.slice(0, cut);
}

/** `loc`, then each enclosing package location, ending with the root `''`. */
function* chain(loc: string): Generator<string> {
  let current = loc;
  for (;;) {
    yield current;
    if (!current) return;
    current = parentLocation(current);
  }
}

const inSubtree = (location: string, loc: string) => loc === '' || location === loc || location.startsWith(loc + '/node_modules/');

/** The platform this runtime reports: a browser, so no native binaries ever fit. */
export const PLATFORM = { os: 'linux', cpu: 'wasm32' } as const;

function fitsPlatform(m: PackageManifest): boolean {
  const ok = (list: string[] | undefined, value: string) =>
    !list?.length || (list.some((x) => x === value) && !list.includes('!' + value)) || (list.every((x) => x.startsWith('!')) && !list.includes('!' + value));
  return ok(m.os, PLATFORM.os) && ok(m.cpu, PLATFORM.cpu);
}

function bundledNames(m: { bundleDependencies?: string[] | boolean; bundledDependencies?: string[] | boolean; dependencies?: Record<string, string> }): Set<string> {
  const field = m.bundleDependencies ?? m.bundledDependencies;
  if (field === true) return new Set(Object.keys(m.dependencies ?? {}));
  return new Set(Array.isArray(field) ? field : []);
}

function dependenciesOf(m: PackageJson | PackageManifest, isRoot: boolean, production: boolean): Dependency[] {
  const out = new Map<string, Dependency>();
  const add = (record: Record<string, string> | undefined, type: EdgeType) => {
    for (const [name, range] of Object.entries(record ?? {})) if (!out.has(name) || type === 'optional') out.set(name, { name, range, type });
  };
  if (isRoot && !production) add((m as PackageJson).devDependencies, 'dev');
  add(m.dependencies, 'prod');
  add(m.optionalDependencies, 'optional');
  if (!isRoot) {
    const meta = (m as PackageManifest).peerDependenciesMeta ?? {};
    for (const [name, range] of Object.entries(m.peerDependencies ?? {})) {
      if (!out.has(name) && !meta[name]?.optional) out.set(name, { name, range, type: 'peer' });
    }
  }
  const bundled = bundledNames(m as PackageManifest);
  return [...out.values()].filter((d) => !bundled.has(d.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Does `version` satisfy the edge's range? A dist-tag never "matches" without a pick. */
function matches(version: string, range: string): boolean {
  const r = range || '*';
  return validRange(r) && satisfies(version, r);
}

export async function resolveTree(options: ResolveTreeOptions): Promise<Map<string, ResolvedPackage>> {
  const nodes = new Map<string, ResolvedPackage>();
  const edges: Edge[] = [];
  const edgesByName = new Map<string, Edge[]>();
  const production = options.production ?? false;

  const lookup = (from: string, name: string): string | undefined => {
    for (const loc of chain(from)) {
      const at = childLocation(loc, name);
      if (nodes.has(at)) return at;
    }
    return undefined;
  };

  const record = (edge: Edge) => {
    edges.push(edge);
    const list = edgesByName.get(edge.name) ?? [];
    list.push(edge);
    edgesByName.set(edge.name, list);
  };

  /** Edges below `loc` that a new `name` at `loc` would capture. */
  const captured = (loc: string, name: string) =>
    (edgesByName.get(name) ?? []).filter((e) => inSubtree(e.from, loc) && !(inSubtree(parentLocation(e.to), loc) && parentLocation(e.to) !== loc));

  const place = (from: string, name: string, version: string): string | undefined => {
    let target: string | undefined;
    for (const loc of chain(from)) {
      if (nodes.has(childLocation(loc, name))) break;
      if (captured(loc, name).some((e) => !matches(version, e.range))) break;
      target = loc;
    }
    return target === undefined ? undefined : childLocation(target, name);
  };

  const queue: Array<{ location: string; deps: Dependency[] }> = [{ location: '', deps: dependenciesOf(options.root, true, production) }];
  while (queue.length) {
    const { location, deps } = queue.shift()!;
    const specs = new Map<string, ParsedSpec>();
    for (const dep of deps) {
      try {
        const spec = parseDependency(dep.name, dep.range);
        specs.set(dep.name, spec);
        options.prefetch?.(spec);
      } catch (error) {
        if (dep.type !== 'optional') throw error;
        options.warn(`skipped optional ${dep.name}: ${(error as Error).message}`);
      }
    }

    for (const dep of deps) {
      const spec = specs.get(dep.name);
      if (!spec) continue;
      const from = dep.type === 'peer' ? parentLocation(location) : location;
      const existing = lookup(from, dep.name);
      const edge = { ...dep, range: spec.range, owner: location, from };
      if (existing && matches(nodes.get(existing)!.manifest.version, spec.range)) {
        record({ ...edge, to: existing });
        continue;
      }
      if (existing && dep.type === 'peer') {
        options.warn(`peer dependency conflict: ${location || 'root'} wants ${dep.name}@${spec.range}, found ${nodes.get(existing)!.manifest.version}`);
        record({ ...edge, to: existing });
        continue;
      }

      let manifest: PackageManifest;
      try {
        manifest = await options.pick(spec);
      } catch (error) {
        if (dep.type !== 'optional') throw error;
        options.warn(`skipped optional ${dep.name}: ${(error as Error).message}`);
        continue;
      }
      if (!fitsPlatform(manifest)) {
        if (dep.type === 'optional') continue; // a native binary for another platform: expected, not an error
        options.warn(`${manifest.name}@${manifest.version} targets ${[manifest.os, manifest.cpu].flat().filter(Boolean).join('/')} and may not work here`);
      }
      if (existing && nodes.get(existing)!.manifest.version === manifest.version) {
        record({ ...edge, to: existing });
        continue;
      }

      const target = place(from, dep.name, manifest.version);
      if (!target) {
        options.warn(`could not place ${dep.name}@${manifest.version} for ${location || 'root'}`);
        continue;
      }
      for (const e of captured(parentLocation(target), dep.name)) e.to = target; // now resolved by the nearer copy
      nodes.set(target, { location: target, name: dep.name, manifest, dev: false, optional: false });
      record({ ...edge, to: target });
      options.onResolved?.({ name: dep.name, version: manifest.version });
      queue.push({ location: target, deps: dependenciesOf(manifest, false, production) });
    }
  }

  markFlags(nodes, edges);
  return nodes;
}

/** npm's `dev`/`optional` flags: reachability from the root without those edge kinds. */
function markFlags(nodes: Map<string, ResolvedPackage>, edges: Edge[]): void {
  const reach = (skip: (e: Edge) => boolean): Set<string> => {
    const seen = new Set<string>();
    const stack = [''];
    while (stack.length) {
      const owner = stack.pop()!;
      for (const e of edges) {
        if (e.owner !== owner || skip(e) || seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    return seen;
  };
  const nonDev = reach((e) => e.owner === '' && e.type === 'dev');
  const nonOptional = reach((e) => e.type === 'optional');
  for (const node of nodes.values()) {
    node.dev = !nonDev.has(node.location);
    node.optional = !nonOptional.has(node.location);
  }
}
