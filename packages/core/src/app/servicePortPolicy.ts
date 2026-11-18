/**
 * The Security Shield's port policy (make.md › PRD 31 §4 W10, control 4): who may
 * reach whose port on a runtime's virtual network. One policy per runtime, many
 * applications: each running application registers its service graph (from the
 * spec's `dependsOn`) for as long as it runs, and unregisters on stop.
 *
 * A caller reaches an owner's port when:
 * - the caller is the platform (the host's own calls) or the workspace (the
 *   developer's terminal, `npm install`, instant preview);
 * - caller and owner are the same (application, service);
 * - both are in the same registered application and the caller's service
 *   declares `dependsOn` the owner's service.
 * Everything else is denied: an application service reaching a workspace or
 * platform port, another application's port, or a service it never declared.
 * Identities come from the page side (`SecurityContext`), never from the process.
 */
import type { PortAccessPolicy } from '../system/ports.js';
import {
  ALLOW,
  deny,
  PLATFORM_APPLICATION,
  sameService,
  WORKSPACE_APPLICATION,
  type SecurityContext,
  type ShieldDecision,
} from '../system/securityContext.js';
import { serviceGraph } from './serviceGraph.js';
import type { ApplicationSpec } from './spec.js';

const RESERVED = new Set([PLATFORM_APPLICATION, WORKSPACE_APPLICATION]);

export class ServiceGraphPolicy implements PortAccessPolicy {
  /** Per application: each service's declared dependencies. */
  private readonly applications = new Map<string, ReadonlyMap<string, ReadonlySet<string>>>();

  /**
   * Put an application's service graph in force under the id the runtime minted
   * for it; returns the unregister. Throws for an invalid spec, a reserved id
   * (`workspace`, `platform`) or an id already registered.
   */
  register(applicationId: string, spec: ApplicationSpec): () => void {
    if (RESERVED.has(applicationId)) throw new Error(`"${applicationId}" is reserved and cannot name an application.`);
    if (this.applications.has(applicationId)) throw new Error(`Application "${applicationId}" is already registered.`);
    serviceGraph(spec); // validates: unknown dependencies, cycles, duplicate ids
    const nodes = new Map(spec.services.map((service) => [service.id, new Set(service.dependsOn ?? [])]));
    this.applications.set(applicationId, nodes);
    return () => {
      if (this.applications.get(applicationId) === nodes) this.applications.delete(applicationId);
    };
  }

  has(applicationId: string): boolean {
    return this.applications.has(applicationId);
  }

  decide(caller: SecurityContext, owner: SecurityContext): ShieldDecision {
    if (caller.applicationId === PLATFORM_APPLICATION || caller.applicationId === WORKSPACE_APPLICATION) return ALLOW;
    if (sameService(caller, owner)) return ALLOW;
    if (caller.applicationId !== owner.applicationId) return deny('port.not_owner');
    return this.declares(caller, owner.serviceId) ? ALLOW : deny('port.edge_not_declared');
  }

  private declares(caller: SecurityContext, serviceId: string): boolean {
    return this.applications.get(caller.applicationId)?.get(caller.serviceId)?.has(serviceId) ?? false;
  }
}
