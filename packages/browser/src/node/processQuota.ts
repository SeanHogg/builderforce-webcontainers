/**
 * Control 9 (make.md › PRD 31 §4 W10): how many processes an application may
 * run at once, and how deep its process tree may grow. The policy is a
 * collaborator of the process host (`ProcessHostOptions.security.quota`), asked
 * before every spawn — page-side starts and the children a Worker spawns alike.
 *
 * The default holds applications only: a process started outside any
 * application (the developer's terminal, `npm install`, instant preview) carries
 * the `workspace` identity and is not counted against an application.
 */
import { ALLOW, WORKSPACE_APPLICATION, deny, type SecurityContext, type ShieldDecision, type ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';

/** What a spawn would make of its application: asked before the process exists. */
export interface SpawnRequest {
  /** Who the new process will be (its parent's identity, or the one a page-side caller gave). */
  readonly context: SecurityContext;
  /** Processes of its application running now, not counting the new one. */
  readonly live: number;
  /** Its depth in the process tree: 0 for a page-side start, its parent's + 1 for a child. */
  readonly depth: number;
}

export interface ProcessQuotaPolicy {
  check(request: SpawnRequest): ShieldDecision;
}

export interface ProcessQuotaLimits {
  /** Processes one application may run at once. Default 64. */
  maxProcesses?: number;
  /** Deepest a process of an application may be (0 is the service's own process). Default 16. */
  maxDepth?: number;
}

export const DEFAULT_PROCESS_QUOTA: Required<ProcessQuotaLimits> = Object.freeze({ maxProcesses: 64, maxDepth: 16 });

/** The default policy: count and depth limits per application; `workspace` processes are not limited. */
export function processQuota(limits: ProcessQuotaLimits = {}): ProcessQuotaPolicy {
  const { maxProcesses, maxDepth } = { ...DEFAULT_PROCESS_QUOTA, ...limits };
  return {
    check({ context, live, depth }) {
      if (context.applicationId === WORKSPACE_APPLICATION) return ALLOW;
      if (live >= maxProcesses) return deny('process.spawn_quota');
      if (depth > maxDepth) return deny('process.depth_quota');
      return ALLOW;
    },
  };
}

/** A refused spawn, as the OS reports one it has no room for: `EAGAIN`, with the shield's reason. */
export class SpawnRefusedError extends Error {
  readonly code = 'EAGAIN';
  constructor(readonly reason: ShieldReasonCode) {
    super(`spawn EAGAIN: refused by the runtime (${reason})`);
    this.name = 'SpawnRefusedError';
  }
}
