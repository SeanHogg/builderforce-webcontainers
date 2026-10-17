import type { ModuleGraph } from './moduleGraph.js';
import { isCssModule, isStylesheet } from '../styles/languages.js';

/**
 * Decide what an edit means for the open preview, from the module graph:
 *
 *   • a plain stylesheet (or a partial one pulls in) is swapped in place;
 *   • a module is re-run at the nearest refresh BOUNDARIES above it — the
 *     changed module itself when it only exports components, else the modules
 *     importing it, and so on — when React Refresh is on;
 *   • reaching a module nothing imports (the entry) without a boundary, or a
 *     component whose hooks changed, means a full reload;
 *   • a file the page never loaded changes nothing.
 *
 * `touched` is every module the update re-runs or passes through: each needs a
 * fresh stamp, so the re-run imports fresh copies all the way down.
 */
export type UpdatePlan = { reload: true } | { reload: false; styles: string[]; boundaries: string[]; touched: string[] };

export interface PlanInput {
  changed: readonly string[];
  graph: ModuleGraph;
  /** React Refresh is available in this preview. */
  refresh: boolean;
  /** The module's hook calls differ from the ones the preview is running. */
  hooksChanged(path: string): boolean;
}

/** A stylesheet whose edit is only a style swap: not a CSS Module, whose class map is JS. */
const isPlainStylesheet = (path: string) => isStylesheet(path) && !isCssModule(path);

export function planUpdate({ changed, graph, refresh, hooksChanged }: PlanInput): UpdatePlan {
  const styles = new Set<string>();
  const boundaries = new Set<string>();
  const touched = new Set<string>();
  const seen = new Set<string>();

  for (const start of changed) {
    if (!graph.isServed(start) && graph.importers(start).size === 0) continue;
    const queue = [start];
    while (queue.length) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      touched.add(path);

      if (isPlainStylesheet(path)) {
        if (graph.isServed(path)) styles.add(path);
        // A partial's edit reaches the stylesheets that pulled it in — never the JS
        // importing a stylesheet, which a swap leaves untouched.
        for (const importer of graph.importers(path)) if (isStylesheet(importer)) queue.push(importer);
        continue;
      }

      if (refresh && hooksChanged(path)) return { reload: true };
      if (refresh && graph.factsOf(path)?.refreshBoundary) {
        boundaries.add(path);
        continue;
      }
      const importers = graph.importers(path);
      if (importers.size === 0) return { reload: true };
      queue.push(...importers);
    }
  }
  return { reload: false, styles: [...styles], boundaries: [...boundaries], touched: [...touched] };
}
