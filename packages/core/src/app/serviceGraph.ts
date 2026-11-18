/**
 * The order services start and stop in. A service starts after every service it
 * depends on; services stop in the reverse order. Ties keep spec order, so the
 * same spec always yields the same order.
 */
import { assertValidSpec } from './validateSpec.js';
import type { ApplicationSpec } from './spec.js';

export interface ServiceGraph {
  /** Every service after all of its dependencies. */
  readonly startOrder: readonly string[];
  /** `startOrder` reversed: dependents stop before what they depend on. */
  readonly stopOrder: readonly string[];
  /** Direct dependencies of a service. */
  dependenciesOf(serviceId: string): readonly string[];
}

/** Throws `ApplicationSpecError` for an invalid spec (unknown dependencies, cycles, …). */
export function serviceGraph(spec: ApplicationSpec): ServiceGraph {
  assertValidSpec(spec);
  const dependencies = new Map(spec.services.map((service) => [service.id, [...new Set(service.dependsOn ?? [])]]));
  const directDependents = new Map<string, string[]>(spec.services.map((service) => [service.id, []]));
  for (const [id, deps] of dependencies) for (const dep of deps) directDependents.get(dep)!.push(id);

  // Kahn's algorithm, always taking the earliest ready service in spec order.
  const remaining = new Map([...dependencies].map(([id, deps]) => [id, deps.length]));
  const startOrder: string[] = [];
  while (startOrder.length < spec.services.length) {
    const next = spec.services.find((service) => remaining.get(service.id) === 0)!;
    remaining.delete(next.id);
    startOrder.push(next.id);
    for (const dependent of directDependents.get(next.id)!) remaining.set(dependent, remaining.get(dependent)! - 1);
  }
  return {
    startOrder,
    stopOrder: [...startOrder].reverse(),
    dependenciesOf: (serviceId) => dependencies.get(serviceId) ?? [],
  };
}
