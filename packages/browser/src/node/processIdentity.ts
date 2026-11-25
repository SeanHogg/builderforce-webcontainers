/**
 * Who each process is (make.md › PRD 31 §4 W10, principle 3): identity is
 * assigned on the page at spawn and kept here, never claimed by the process.
 *
 * - A page-side start (`ProcessHost.run` / `spawnChild`) takes the `identity`
 *   its caller gives — the application runtime mints one per service — or, with
 *   none, `workspace` (terminal, `npm install`, instant preview). Never `platform`.
 * - A child a Worker spawns inherits its parent's record. Nothing the Worker's
 *   message carries (env such as `BUILDERFORCE_SERVICE`, any field) counts.
 *
 * Every process stays attributed to its application until it exits, `detached`
 * ones included, so the host can end an application's whole set
 * (`ProcessHost.killApplication`). Before a process exists its application's
 * quota is asked (processQuota.ts); an application process also gets the file
 * system view of its service directory (fsScope.ts), which its children share.
 */
import {
  PLATFORM_APPLICATION,
  WORKSPACE_APPLICATION,
  WORKSPACE_CONTEXT,
  type ProcessOptions,
  type SecurityContext,
  type ShieldDecision,
} from '@seanhogg/builderforce-webcontainers-core';
import { FsScopes, type FsScopeOptions, type FsView } from './fsScope.js';
import { SpawnRefusedError, processQuota, type ProcessQuotaPolicy } from './processQuota.js';
import type { CodeScanner, ScanIncompletePolicy } from '@seanhogg/builderforce-webcontainers-core';
import type { ShieldTelemetry } from '../security/shieldTelemetry.js';

/** A page-side start's options: a process's own options, plus who it is. */
export interface SpawnOptions extends ProcessOptions {
  /**
   * Who the process is: `(applicationId, serviceId)`, assigned by the page-side
   * caller (the application runtime). Default `workspace`. Ignored for a child a
   * Worker spawns — it inherits its parent's.
   */
  identity?: SecurityContext;
}

/** The Security Shield's process and file-system controls (`ProcessHostOptions.security`). */
export interface ProcessShieldOptions {
  /** Spawn count and depth per application. Default `processQuota()` (64 processes, depth 16). */
  quota?: ProcessQuotaPolicy;
  /** Platform paths and shared dependencies of the application views (the workspace root is the host's `cwd`). */
  scope?: Omit<FsScopeOptions, 'workspaceRoot'>;
  /** Every refusal (a spawn over quota, a write outside an application's view). Telemetry, failing open: enforcement never depends on it. */
  onDecision?(context: SecurityContext, decision: ShieldDecision): void;
  /**
   * The runtime's Security Shield telemetry (`createShieldTelemetry`, built once
   * by the host): port-registry refusals, quota and file-system refusals and
   * ingress limits are reported to it as the page-side identity. Failing open.
   */
  telemetry?: ShieldTelemetry;
  /** The embedder's code scanner (trusted config, never reachable from a process): installs, writes and spawns are checked against it. */
  scanner?: CodeScanner;
  /** A scan that could not finish: `warn` (default) or `refuse` (an install is refused). */
  onScanIncomplete?: ScanIncompletePolicy;
  /** Request-body limit on loopback and host-API HTTP. Default the service worker's (32 MiB). */
  maxBodyBytes?: number;
}

/** What the page knows of a process: who it is, how deep, and what of the file system it sees. */
export interface Attribution {
  readonly context: SecurityContext;
  readonly depth: number;
  /** Undefined for `workspace` processes: the full file system. */
  readonly view?: FsView;
}

/** Who asks for a process: a page-side caller (its `identity`), or a running process (its pid). */
export type SpawnOrigin = { readonly parent: number } | { readonly identity?: SecurityContext };

export class ProcessIdentities {
  private readonly records = new Map<number, Attribution>();
  /** Running processes per application. */
  private readonly live = new Map<string, number>();
  private readonly scopes: FsScopes;
  private readonly quota: ProcessQuotaPolicy;

  constructor(workspaceRoot: string, private readonly options: ProcessShieldOptions = {}) {
    this.scopes = new FsScopes({ ...options.scope, workspaceRoot });
    this.quota = options.quota ?? processQuota();
  }

  /**
   * Who a new process will be, decided before it exists (`cwd` roots an
   * application's view). Throws `SpawnRefusedError` (EAGAIN) when its
   * application is over quota.
   */
  admit(origin: SpawnOrigin, cwd: string): Attribution {
    const inherited = 'parent' in origin ? this.records.get(origin.parent) : undefined;
    // A parent already gone never falls back to `workspace`: its child is refused.
    if ('parent' in origin && !inherited) throw Object.assign(new Error('spawn ESRCH: the parent process exited'), { code: 'ESRCH' });
    const given = 'parent' in origin ? undefined : origin.identity;
    const base = inherited?.context ?? given ?? WORKSPACE_CONTEXT;
    if (base.applicationId === PLATFORM_APPLICATION) throw new TypeError('A process cannot carry the platform identity.');
    const context: SecurityContext = { applicationId: base.applicationId, serviceId: base.serviceId };
    const depth = inherited ? inherited.depth + 1 : 0;
    const decision = this.quota.check({ context, live: this.live.get(context.applicationId) ?? 0, depth });
    if (!decision.allow) {
      this.report(context, decision, { live: this.live.get(context.applicationId) ?? 0, depth, parentPid: 'parent' in origin ? origin.parent : null });
      throw new SpawnRefusedError(decision.reason);
    }
    const view = inherited ? inherited.view : context.applicationId === WORKSPACE_APPLICATION ? undefined : this.scopes.view(context.applicationId, cwd);
    return { context, depth, view };
  }

  /** The process `admit` let in is running as `pid`. */
  register(pid: number, admitted: Attribution): void {
    this.records.set(pid, { ...admitted, context: Object.freeze({ ...admitted.context, processId: pid }) });
    const app = admitted.context.applicationId;
    this.live.set(app, (this.live.get(app) ?? 0) + 1);
  }

  /** `pid` exited. */
  release(pid: number): void {
    const record = this.records.get(pid);
    if (!record) return;
    this.records.delete(pid);
    const app = record.context.applicationId;
    const left = (this.live.get(app) ?? 1) - 1;
    if (left > 0) this.live.set(app, left);
    else this.live.delete(app);
  }

  identityOf(pid: number): SecurityContext | undefined {
    return this.records.get(pid)?.context;
  }

  /** Whether `pid` belongs to the application (and, given, the service). */
  attributedTo(pid: number, applicationId: string, serviceId?: string): boolean {
    const context = this.records.get(pid)?.context;
    return context !== undefined && context.applicationId === applicationId && (serviceId === undefined || context.serviceId === serviceId);
  }

  /** Tell `onDecision` and the shield's telemetry; a throwing listener changes nothing. */
  report(context: SecurityContext, decision: ShieldDecision, evidence?: Readonly<Record<string, unknown>>): void {
    try {
      this.options.onDecision?.(context, decision);
    } catch {
      // Telemetry fails open.
    }
    this.options.telemetry?.decision(context, decision, evidence); // fails open itself
  }
}
