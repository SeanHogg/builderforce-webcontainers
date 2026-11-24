/**
 * Capabilities as data: what a manifest may enable under `capabilities`, what
 * each depends on and requires of a target, and how its config is checked.
 * Core holds only definitions; hook code comes from `load()`, which a host
 * package registers, so an environment without a capability never loads it.
 */
import type { ResourceType } from '../manifest/types.js';

/** One problem in a capability's config. `path` is relative to the config; `''` is its root. */
export interface CapabilityConfigIssue {
  path: string;
  detail: string;
}

/** Lifecycle hooks a host package supplies for a capability. */
export interface CapabilityHooks {
  install?(): Promise<void>;
  activate?(): Promise<void>;
  deactivate?(): Promise<void>;
  checkpoint?(): Promise<unknown>;
  recover?(state: unknown): Promise<void>;
}

export interface CapabilityDefinition {
  readonly id: string;
  readonly version: number;
  /** Capabilities the manifest must enable as well. */
  readonly dependsOn: readonly string[];
  /** Resource types the target must support (`RESOURCE_CAPABILITIES`). */
  readonly requires: readonly ResourceType[];
  /** JSON Schema of the config under `capabilities.<id>`. */
  readonly configSchema: Readonly<Record<string, unknown>>;
  validateConfig?(config: unknown): CapabilityConfigIssue[];
  load?(): Promise<CapabilityHooks>;
}

export interface CapabilityRegistry {
  get(id: string): CapabilityDefinition | undefined;
  has(id: string): boolean;
  ids(): string[];
}

/** A registry of `defs`. Throws on a duplicate id: that is a programming error, not a manifest issue. */
export function createCapabilityRegistry(defs: readonly CapabilityDefinition[]): CapabilityRegistry {
  // A Map, so no prototype key (`constructor`, `__proto__`) ever matches a definition.
  const byId = new Map<string, CapabilityDefinition>();
  for (const def of defs) {
    if (byId.has(def.id)) throw new Error(`Capability "${def.id}" is registered twice.`);
    byId.set(def.id, def);
  }
  return {
    get: (id) => byId.get(id),
    has: (id) => byId.has(id),
    ids: () => [...byId.keys()],
  };
}

export type CapabilityOrder = { ok: true; order: string[] } | { ok: false; cycle: string[] };

/** `ids` in dependency order (dependencies first), or the first cycle found. Ids not registered are ignored. */
export function orderCapabilities(ids: readonly string[], registry: CapabilityRegistry): CapabilityOrder {
  const order: string[] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (done.has(id) || !registry.has(id)) return undefined;
    const at = stack.indexOf(id);
    if (at >= 0) return [...stack.slice(at), id];
    stack.push(id);
    for (const dependency of registry.get(id)!.dependsOn) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    done.add(id);
    order.push(id);
    return undefined;
  };
  for (const id of ids) {
    const cycle = visit(id);
    if (cycle) return { ok: false, cycle };
  }
  return { ok: true, order };
}
