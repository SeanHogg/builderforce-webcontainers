/**
 * Child runtimes (W12 phase 6): a runtime starts child runtimes, each under a
 * policy narrowed from its parent's (`narrowChildPolicy` in core: a wider tool
 * allowlist, a bigger budget, more children or a deeper nesting is refused with
 * typed issues, never clamped).
 *
 * Each child has its own id (`crypto.randomUUID`), VFS namespace prefix, lease
 * (`claimRuntimeLease`) and persistence key, and a hierarchy record
 * `{ formatVersion, environmentId, parentId, childIds }` kept through a store
 * port (IndexedDB by default). After the tab dies, `rediscover(parentId)` reads
 * the parent's record and recovers each child by id, independently: one child
 * that is corrupt or fails to recover never stops the others.
 *
 * A child's failure stays at the child boundary: a boot that throws, or a
 * failure the child reports later (`context.fail`), becomes a typed
 * `child-failed` result and event and is never rethrown into the parent.
 *
 * This is a LOGICAL boundary, not OS isolation: a child runs in the same tab,
 * realm and memory as its parent. The namespace, lease and policy keep children
 * apart by contract; code that ignores them is not contained.
 */
import { AGENTS_CAPABILITY, PERSISTED_FORMAT_VERSION, countWideningIssues, narrowChildPolicy } from '@seanhogg/builderforce-webcontainers-core';
import type { AgentsPolicy, ManifestIssue } from '@seanhogg/builderforce-webcontainers-core/manifest';
import { messageOf } from '../app/asyncHelpers.js';
import { narrowHostRelay, type AiCeiling, type HostRelay } from '../app/hostRelay.js';
import { lazyIdbStore } from '../shared/idb.js';
import { claimRuntimeLease, type LeaseTokenStore, type LockManagerLike, type RuntimeLease } from '../shared/runtimeLease.js';

/** Where a runtime sits in its environment's tree; persisted once per runtime, keyed by `environmentId`. */
export interface ChildHierarchyRecord {
  formatVersion: typeof PERSISTED_FORMAT_VERSION;
  /** This runtime's id (the root environment's id, or a child's id). */
  environmentId: string;
  parentId: string | null;
  childIds: string[];
  /** A child's narrowed policy, so it recovers under the same ceilings. */
  policy?: AgentsPolicy;
}

/** Persists hierarchy records. `load` returns the raw stored value (or undefined), so a corrupt one is reported, not trusted. */
export interface ChildHierarchyStore {
  load(environmentId: string): Promise<unknown>;
  save(record: ChildHierarchyRecord): Promise<void>;
}

/** The hierarchy store could not be reached. */
export class ChildHierarchyStorageError extends Error {
  constructor(readonly environmentId: string) {
    super(`The child-runtime hierarchy of "${environmentId}" cannot be kept: IndexedDB is unavailable or blocked.`);
    this.name = 'ChildHierarchyStorageError';
  }
}

const HIERARCHY_DB = { dbName: 'bfwc-child-runtimes', storeName: 'hierarchy', version: 1 };

/** Hierarchy records in IndexedDB (`bfwc-child-runtimes`), through the shared IDB helper. */
export function indexedDbChildHierarchyStore(factory: IDBFactory | undefined = globalThis.indexedDB): ChildHierarchyStore {
  const open = lazyIdbStore(factory, HIERARCHY_DB);
  const store = async (environmentId: string) => {
    const opened = await open();
    if (!opened) throw new ChildHierarchyStorageError(environmentId);
    return opened;
  };
  return {
    async load(environmentId) {
      return (await store(environmentId)).run('readonly', (records) => records.get(environmentId) as IDBRequest<unknown>);
    },
    async save(record) {
      await (await store(record.environmentId)).run('readwrite', (records) => records.put(record, record.environmentId));
    },
  };
}

/** Hierarchy records in memory (tests, ephemeral environments). `records` is the backing map, exposed for inspection. */
export function memoryChildHierarchyStore(records: Map<string, unknown> = new Map()): ChildHierarchyStore & { records: Map<string, unknown> } {
  return {
    records,
    async load(environmentId) {
      return structuredClone(records.get(environmentId));
    },
    async save(record) {
      records.set(record.environmentId, structuredClone(record));
    },
  };
}

/** The keys a child owns, all derived from its id. */
export interface ChildRuntimeKeys {
  /** Prefix of the child's files in the VFS. */
  namespace: string;
  /** The lease (`claimRuntimeLease`) that makes one tab the child's owner. */
  leaseKey: string;
  /** Where the child persists its own state. */
  persistenceKey: string;
}

export const childRuntimeKeys = (id: string): ChildRuntimeKeys => ({
  namespace: `/.builderforce/children/${id}/`,
  leaseKey: `child-runtime:${id}`,
  persistenceKey: `child-runtime/${id}`,
});

/** What a child's boot function receives. */
export interface ChildRuntimeContext extends ChildRuntimeKeys {
  id: string;
  parentId: string;
  /** The child's depth in the tree (the root is 0). */
  depth: number;
  policy: AgentsPolicy;
  /** True when restoring a child after its tab died, false for a new one. */
  recovering: boolean;
  lease: RuntimeLease;
  /** The model relay, never wider than the parent's: absent unless the parent supplied a relay and a ceiling. */
  hostRelay?: HostRelay;
  /** Report a failure after boot; it becomes a `child-failed` event and never reaches the parent. */
  fail(error: unknown): void;
}

/** What a booted child hands back. */
export interface ChildRuntimeHandle {
  stop?(): Promise<void> | void;
}

export type ChildBoot = (context: ChildRuntimeContext) => Promise<ChildRuntimeHandle>;

export type ChildRuntimeState = 'ready' | 'failed' | 'stopped';

export interface ChildRuntime extends ChildRuntimeKeys {
  readonly id: string;
  readonly parentId: string;
  readonly depth: number;
  readonly policy: AgentsPolicy;
  readonly state: ChildRuntimeState;
  /** Stop the child and release its lease; its hierarchy and state stay, so it can be recovered. */
  stop(): Promise<void>;
}

export type ChildFailurePhase = 'lease' | 'persist' | 'boot' | 'run' | 'stop';

/** A child failed; the parent is unaffected. */
export interface ChildFailure {
  code: 'child-failed';
  childId: string;
  parentId: string;
  phase: ChildFailurePhase;
  detail: string;
  error: unknown;
}

export interface ChildFailed {
  failed: ChildFailure;
}

export interface ChildRefused {
  refused: ManifestIssue[];
}

/** A child another tab owns; it recovers there. */
export interface ChildOwnedElsewhere {
  ownedElsewhere: string;
}

export type ChildHierarchyIssueCode = 'hierarchy-corrupt' | 'hierarchy-unsupported-version' | 'hierarchy-unreadable' | 'child-missing';

/** A hierarchy record that could not be used. */
export interface ChildHierarchyIssue {
  code: ChildHierarchyIssueCode;
  environmentId: string;
  detail: string;
}

export interface Rediscovered {
  children: Array<ChildRuntime | ChildFailed | ChildOwnedElsewhere>;
  issues: ChildHierarchyIssue[];
}

export type ChildRuntimeEvent =
  | { type: 'child-started'; childId: string; parentId: string; recovering: boolean }
  | { type: 'child-refused'; parentId: string; issues: ManifestIssue[] }
  | { type: 'child-failed'; failure: ChildFailure }
  | { type: 'child-stopped'; childId: string; parentId: string }
  | { type: 'hierarchy-issue'; issue: ChildHierarchyIssue };

export interface ChildRuntimesDeps {
  /** Web Locks (`navigator.locks`); without them a child's lease is refused, so it fails at `lease`. */
  locks: LockManagerLike | undefined;
  /** Fencing tokens of the children's leases; `claimRuntimeLease`'s IndexedDB store by default. */
  leaseTokens?: LeaseTokenStore;
  /** Claims a child's lease; default `claimRuntimeLease(locks, key, leaseTokens)`. */
  claimLease?: (key: string) => Promise<RuntimeLease>;
  hierarchy: ChildHierarchyStore;
  /** The parent's policy, which every child narrows. */
  policy: AgentsPolicy;
  /** The parent's depth (the root is 0). */
  depth: number;
  /** Start (or, with `recovering`, restore) one child. */
  boot: ChildBoot;
  /** The parent's model relay; a child only ever gets it narrowed by `aiCeiling`. */
  hostRelay?: HostRelay;
  /** What a child may reach on the relay. Without it a child gets no relay (fail closed). */
  aiCeiling?: AiCeiling;
  onEvent?: (event: ChildRuntimeEvent) => void;
  newId?: () => string;
}

export interface ChildRuntimes {
  createChildRuntime(parentId: string, manifestFragment: unknown): Promise<ChildRuntime | ChildRefused | ChildFailed>;
  /** Recover every child the hierarchy of `environmentId` lists, each on its own. */
  rediscover(environmentId: string): Promise<Rediscovered>;
}

const issue = (code: ChildHierarchyIssueCode, environmentId: string, detail: string): ChildHierarchyIssue => ({ code, environmentId, detail });

/** A stored record this runtime wrote for `environmentId`, or the typed issue that keeps it from being used. */
export function parseChildHierarchyRecord(raw: unknown, environmentId: string): ChildHierarchyRecord | ChildHierarchyIssue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return issue('hierarchy-corrupt', environmentId, 'The hierarchy record is not an object.');
  const record = raw as Record<string, unknown>;
  if (record.formatVersion !== PERSISTED_FORMAT_VERSION) {
    return issue('hierarchy-unsupported-version', environmentId, `The hierarchy record has format version ${String(record.formatVersion)}; this runtime reads ${PERSISTED_FORMAT_VERSION}.`);
  }
  if (record.environmentId !== environmentId) return issue('hierarchy-corrupt', environmentId, `The hierarchy record is for "${String(record.environmentId)}".`);
  if (!(record.parentId === null || (typeof record.parentId === 'string' && record.parentId !== ''))) return issue('hierarchy-corrupt', environmentId, '"parentId" must be an id or null.');
  const { childIds } = record;
  if (!Array.isArray(childIds) || childIds.some((id) => typeof id !== 'string' || id === '')) return issue('hierarchy-corrupt', environmentId, '"childIds" must be a list of ids.');
  if (record.policy !== undefined && (AGENTS_CAPABILITY.validateConfig?.(record.policy) ?? []).length > 0) return issue('hierarchy-corrupt', environmentId, '"policy" is not a valid agents policy.');
  const parsed: ChildHierarchyRecord = { formatVersion: PERSISTED_FORMAT_VERSION, environmentId, parentId: record.parentId as string | null, childIds: [...(childIds as string[])] };
  if (record.policy !== undefined) parsed.policy = record.policy as AgentsPolicy;
  return parsed;
}

const isIssue = (parsed: ChildHierarchyRecord | ChildHierarchyIssue): parsed is ChildHierarchyIssue => !('formatVersion' in parsed);

export function createChildRuntimes(deps: ChildRuntimesDeps): ChildRuntimes {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const childDepth = deps.depth + 1;
  const claimLease = deps.claimLease ?? ((key: string) => claimRuntimeLease(deps.locks, key, deps.leaseTokens));
  /** Read-modify-writes of one parent's record, one at a time. */
  const parentQueues = new Map<string, Promise<unknown>>();

  const emit = (event: ChildRuntimeEvent): void => {
    try {
      deps.onEvent?.(event);
    } catch (error) {
      // error-logging: a broken listener must not take a child (or the parent) down with it.
      console.error('[bfwc] A child-runtime event listener threw:', error);
    }
  };

  const failed = (childId: string, parentId: string, phase: ChildFailurePhase, error: unknown): ChildFailed => {
    const failure: ChildFailure = { code: 'child-failed', childId, parentId, phase, detail: messageOf(error), error };
    emit({ type: 'child-failed', failure });
    return { failed: failure };
  };

  const withParent = <T>(parentId: string, task: () => Promise<T>): Promise<T> => {
    const run = (parentQueues.get(parentId) ?? Promise.resolve()).then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    parentQueues.set(parentId, settled);
    void settled.then(() => {
      if (parentQueues.get(parentId) === settled) parentQueues.delete(parentId);
    });
    return run;
  };

  /** The parent's record, or a fresh root record when it has none; throws on a corrupt one (never overwritten). */
  const parentRecord = async (parentId: string): Promise<ChildHierarchyRecord> => {
    const raw = await deps.hierarchy.load(parentId);
    if (raw === undefined) return { formatVersion: PERSISTED_FORMAT_VERSION, environmentId: parentId, parentId: null, childIds: [] };
    const parsed = parseChildHierarchyRecord(raw, parentId);
    if (isIssue(parsed)) throw new Error(parsed.detail);
    return parsed;
  };

  /** Claim the lease, boot, and wrap the child; every failure is a `ChildFailed`. */
  const start = async (id: string, parentId: string, policy: AgentsPolicy, recovering: boolean): Promise<ChildRuntime | ChildFailed | ChildOwnedElsewhere> => {
    const keys = childRuntimeKeys(id);
    let lease: RuntimeLease;
    try {
      lease = await claimLease(keys.leaseKey);
    } catch (error) {
      return failed(id, parentId, 'lease', error);
    }
    if (lease.state.kind !== 'owner') {
      lease.release();
      return { ownedElsewhere: id };
    }
    let state: ChildRuntimeState = 'ready';
    let handle: ChildRuntimeHandle | undefined;
    const context: ChildRuntimeContext = {
      ...keys,
      id,
      parentId,
      depth: childDepth,
      policy,
      recovering,
      lease,
      ...(deps.hostRelay && deps.aiCeiling ? { hostRelay: narrowHostRelay(deps.hostRelay, deps.aiCeiling) } : {}),
      fail(error) {
        if (state !== 'ready') return;
        state = 'failed';
        lease.release();
        failed(id, parentId, 'run', error);
      },
    };
    try {
      handle = await deps.boot(context);
    } catch (error) {
      lease.release();
      return failed(id, parentId, 'boot', error);
    }
    emit({ type: 'child-started', childId: id, parentId, recovering });
    return {
      ...keys,
      id,
      parentId,
      depth: childDepth,
      policy,
      get state() {
        return state;
      },
      async stop() {
        if (state === 'stopped') return;
        state = 'stopped';
        try {
          await handle?.stop?.();
        } catch (error) {
          failed(id, parentId, 'stop', error);
        } finally {
          lease.release();
        }
        emit({ type: 'child-stopped', childId: id, parentId });
      },
    };
  };

  return {
    async createChildRuntime(parentId, manifestFragment) {
      const narrowed = narrowChildPolicy(deps.policy, manifestFragment);
      if (!narrowed.policy) {
        emit({ type: 'child-refused', parentId, issues: narrowed.issues });
        return { refused: narrowed.issues };
      }
      const policy = narrowed.policy;
      const id = newId();
      // Record the child before it boots, so a tab that dies mid-boot still finds it.
      let registered: ChildRefused | true;
      try {
        registered = await withParent(parentId, async () => {
          const parent = await parentRecord(parentId);
          const tooMany = countWideningIssues('maxChildren', parent.childIds.length + 1, deps.policy.maxChildren, 'children', `At most ${deps.policy.maxChildren} child runtimes.`);
          if (tooMany.length > 0) return { refused: tooMany };
          await deps.hierarchy.save({ formatVersion: PERSISTED_FORMAT_VERSION, environmentId: id, parentId, childIds: [], policy });
          await deps.hierarchy.save({ ...parent, childIds: [...parent.childIds, id] });
          return true as const;
        });
      } catch (error) {
        return failed(id, parentId, 'persist', error);
      }
      if (registered !== true) {
        emit({ type: 'child-refused', parentId, issues: registered.refused });
        return registered;
      }
      const started = await start(id, parentId, policy, false);
      // A new id is never owned elsewhere; a child that never booted has nothing to recover, so it leaves the hierarchy.
      if ('ownedElsewhere' in started) return failed(id, parentId, 'lease', new Error(`The lease of new child "${id}" is held elsewhere.`));
      if ('failed' in started) {
        try {
          await withParent(parentId, async () => {
            const parent = await parentRecord(parentId);
            await deps.hierarchy.save({ ...parent, childIds: parent.childIds.filter((child) => child !== id) });
          });
        } catch (error) {
          // error-logging: the child stays listed and fails again at rediscovery; the boot failure is the one returned.
          console.error(`[bfwc] Could not drop failed child "${id}" from the hierarchy of "${parentId}":`, error);
        }
      }
      return started;
    },

    async rediscover(environmentId) {
      const issues: ChildHierarchyIssue[] = [];
      const report = (found: ChildHierarchyIssue) => {
        issues.push(found);
        emit({ type: 'hierarchy-issue', issue: found });
      };
      let raw: unknown;
      try {
        raw = await deps.hierarchy.load(environmentId);
      } catch (error) {
        report(issue('hierarchy-unreadable', environmentId, messageOf(error)));
        return { children: [], issues };
      }
      if (raw === undefined) return { children: [], issues };
      const parent = parseChildHierarchyRecord(raw, environmentId);
      if (isIssue(parent)) {
        report(parent);
        return { children: [], issues };
      }
      const recovered = await Promise.all(
        parent.childIds.map(async (childId): Promise<ChildRuntime | ChildFailed | ChildOwnedElsewhere | undefined> => {
          let childRaw: unknown;
          try {
            childRaw = await deps.hierarchy.load(childId);
          } catch (error) {
            report(issue('hierarchy-unreadable', childId, messageOf(error)));
            return undefined;
          }
          if (childRaw === undefined) {
            report(issue('child-missing', childId, `"${environmentId}" lists child "${childId}", which has no hierarchy record.`));
            return undefined;
          }
          const child = parseChildHierarchyRecord(childRaw, childId);
          if (isIssue(child)) {
            report(child);
            return undefined;
          }
          if (child.parentId !== environmentId) {
            report(issue('hierarchy-corrupt', childId, `The child's parent is "${String(child.parentId)}", not "${environmentId}".`));
            return undefined;
          }
          // A child recorded without a policy recovers under the parent's, narrowed one level down.
          const policy = child.policy ?? narrowChildPolicy(deps.policy, undefined).policy;
          if (!policy) {
            report(issue('hierarchy-corrupt', childId, 'The child has no policy and the parent allows no child.'));
            return undefined;
          }
          try {
            return await start(childId, environmentId, policy, true);
          } catch (error) {
            return failed(childId, environmentId, 'boot', error);
          }
        }),
      );
      return { children: recovered.filter((child) => child !== undefined), issues };
    },
  };
}
