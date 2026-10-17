/**
 * What the open preview has loaded, and what depends on what — the graph a hot
 * update walks. Nodes are VFS paths. An edge `a → b` means serving `a` read `b`:
 * a module's local imports, or the partials a Sass/Less stylesheet pulled in.
 *
 * Each module may carry a STAMP: bumped when a hot update re-runs it, and
 * written into the import URLs that point at it (`?t=3`), so the browser — whose
 * module map is keyed by URL — fetches a fresh copy instead of the one it holds.
 */
export interface ModuleFacts {
  /** Every export is a React component, so React Refresh can swap it in place. */
  refreshBoundary: boolean;
  /** The hooks the module calls, in order; a change means component state cannot survive. */
  hooks: string;
}

export class ModuleGraph {
  private readonly importsOf = new Map<string, Set<string>>();
  private readonly importersOf = new Map<string, Set<string>>();
  private readonly stamps = new Map<string, number>();
  private readonly facts = new Map<string, ModuleFacts>();
  private readonly served = new Set<string>();
  private clock = 0;

  /** Replace what `module` reads; called each time it is compiled. */
  setDependencies(module: string, dependencies: Iterable<string>): void {
    for (const old of this.importsOf.get(module) ?? []) this.importersOf.get(old)?.delete(module);
    const next = new Set([...dependencies].filter((dependency) => dependency !== module));
    this.importsOf.set(module, next);
    for (const dependency of next) {
      let importers = this.importersOf.get(dependency);
      if (!importers) this.importersOf.set(dependency, (importers = new Set()));
      importers.add(module);
    }
  }

  importers(path: string): ReadonlySet<string> {
    return this.importersOf.get(path) ?? new Set();
  }

  /** Everything that reads `path`, directly or through others (`path` itself excluded). */
  dependents(path: string): Set<string> {
    const found = new Set<string>();
    const queue = [...this.importers(path)];
    while (queue.length) {
      const next = queue.pop()!;
      if (found.has(next) || next === path) continue;
      found.add(next);
      queue.push(...this.importers(next));
    }
    return found;
  }

  markServed(path: string): void {
    this.served.add(path);
  }

  /** The preview requested `path` itself (a module, a stylesheet, an image). */
  isServed(path: string): boolean {
    return this.served.has(path);
  }

  setFacts(path: string, facts: ModuleFacts): void {
    this.facts.set(path, facts);
  }

  factsOf(path: string): ModuleFacts | undefined {
    return this.facts.get(path);
  }

  stampOf(path: string): number | undefined {
    return this.stamps.get(path);
  }

  /** Give every path in `paths` one new stamp, and return it. */
  bump(paths: Iterable<string>): number {
    const stamp = ++this.clock;
    for (const path of paths) this.stamps.set(path, stamp);
    return stamp;
  }

  /** Forget everything: the page is reloading and will request it all again. Stamps keep rising. */
  clear(): void {
    this.importsOf.clear();
    this.importersOf.clear();
    this.facts.clear();
    this.served.clear();
    this.stamps.clear();
  }
}
