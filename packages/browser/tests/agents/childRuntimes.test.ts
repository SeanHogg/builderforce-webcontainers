import { describe, expect, it, vi } from 'vitest';
import type { AgentsPolicy } from '@seanhogg/builderforce-webcontainers-core/manifest';
import {
  createChildRuntimes,
  memoryChildHierarchyStore,
  type ChildBoot,
  type ChildRuntime,
  type ChildRuntimeContext,
  type ChildRuntimeEvent,
  type ChildRuntimesDeps,
} from '../../src/agents.js';
import type { RuntimeLease } from '../../src/shared/runtimeLease.js';

/**
 * Leases shared by several fake tabs, one owner per key; `kill` frees a tab's
 * leases the way the browser frees a dead tab's Web Locks. Injected through
 * `claimLease`, so these tests do not depend on `claimRuntimeLease`'s internals.
 */
class FakeLeases {
  private readonly held = new Map<string, string>();
  private token = 0;

  claim(tab: string): (key: string) => Promise<RuntimeLease> {
    return async (key) => {
      if (this.held.has(key)) return { state: { kind: 'owned-elsewhere' }, onOwner() {}, release() {}, assertFence: () => false };
      this.held.set(key, tab);
      const fencingToken = ++this.token;
      let owned = true;
      return {
        get state() {
          return owned ? { kind: 'owner' as const, fencingToken } : { kind: 'owned-elsewhere' as const };
        },
        onOwner() {},
        release: () => {
          owned = false;
          if (this.held.get(key) === tab) this.held.delete(key);
        },
        assertFence: (token) => owned && token === fencingToken,
      };
    };
  }

  kill(tab: string): void {
    for (const [key, holder] of [...this.held]) if (holder === tab) this.held.delete(key);
  }

  heldBy(key: string): string | undefined {
    return this.held.get(key);
  }
}

const ROOT = 'env-root';
const parentPolicy: AgentsPolicy = { maxDepth: 2, maxChildren: 3, tools: ['env.fs.read', 'env.fs.write', 'env.run'], budget: { tokens: 1000 } };

/** A child that keeps its own state under its persistence key, and restores it from there when recovering. */
function statefulBoot(persisted: Map<string, unknown>, booted: ChildRuntimeContext[]): ChildBoot {
  return async (context) => {
    booted.push(context);
    if (!context.recovering) persisted.set(context.persistenceKey, { files: [`${context.namespace}notes.md`] });
    else if (!persisted.has(context.persistenceKey)) throw new Error(`Nothing persisted for ${context.id}.`);
    return {};
  };
}

function setup(overrides: Partial<ChildRuntimesDeps> = {}) {
  const locks = new FakeLeases();
  const hierarchy = memoryChildHierarchyStore();
  const persisted = new Map<string, unknown>();
  const booted: ChildRuntimeContext[] = [];
  const events: ChildRuntimeEvent[] = [];
  const runtimes = (tab: string, more: Partial<ChildRuntimesDeps> = {}) =>
    createChildRuntimes({ locks: undefined, claimLease: locks.claim(tab), hierarchy, policy: parentPolicy, depth: 0, boot: statefulBoot(persisted, booted), onEvent: (event) => events.push(event), ...overrides, ...more });
  return { locks, hierarchy, persisted, booted, events, runtimes };
}

const asChild = (result: unknown): ChildRuntime => {
  expect(result).toHaveProperty('state', 'ready');
  return result as ChildRuntime;
};

describe('child runtimes', () => {
  it('accepts a stricter child with its own id, namespace, lease and persistence key', async () => {
    const { runtimes, hierarchy, locks } = setup();
    const children = runtimes('tab-a');
    const child = asChild(await children.createChildRuntime(ROOT, { tools: ['env.fs.read'], budget: { tokens: 100 } }));
    const sibling = asChild(await children.createChildRuntime(ROOT, {}));

    expect(child.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(child.policy).toEqual({ maxDepth: 1, maxChildren: 3, tools: ['env.fs.read'], budget: { tokens: 100 } });
    expect(child.depth).toBe(1);
    expect(new Set([child.id, sibling.id]).size).toBe(2);
    for (const key of ['namespace', 'leaseKey', 'persistenceKey'] as const) {
      expect(child[key]).toContain(child.id);
      expect(child[key]).not.toBe(sibling[key]);
    }
    expect(locks.heldBy(child.leaseKey)).toBe('tab-a');
    expect(hierarchy.records.get(ROOT)).toEqual({ formatVersion: 1, environmentId: ROOT, parentId: null, childIds: [child.id, sibling.id] });
    expect(hierarchy.records.get(child.id)).toMatchObject({ formatVersion: 1, environmentId: child.id, parentId: ROOT, childIds: [] });
  });

  it('refuses a wider allowlist and a deeper child with typed issues, recording nothing', async () => {
    const { runtimes, hierarchy, booted, events } = setup();
    const children = runtimes('tab-a');

    const wider = await children.createChildRuntime(ROOT, { tools: ['env.fs.read', 'env.preview.fetch'] });
    expect(wider).toEqual({ refused: [expect.objectContaining({ code: 'policy-widening', path: 'tools', value: 'env.preview.fetch', severity: 'error' })] });

    const deeper = await children.createChildRuntime(ROOT, { maxDepth: 2 });
    expect(deeper).toEqual({ refused: [expect.objectContaining({ code: 'policy-widening', path: 'maxDepth', value: 'maxDepth' })] });

    // A leaf (maxDepth 0) may start nothing: its child would sit one level deeper than its ceiling allows.
    const leaf = asChild(await children.createChildRuntime(ROOT, { maxDepth: 0 }));
    const grandchildren = runtimes('tab-a', { policy: leaf.policy, depth: leaf.depth });
    expect(await grandchildren.createChildRuntime(leaf.id, {})).toEqual({ refused: [expect.objectContaining({ code: 'policy-widening', value: 'maxDepth' })] });

    expect(booted.map((context) => context.id)).toEqual([leaf.id]);
    expect(hierarchy.records.get(ROOT)).toMatchObject({ childIds: [leaf.id] });
    expect(hierarchy.records.get(leaf.id)).toMatchObject({ childIds: [] });
    expect(events.filter((event) => event.type === 'child-refused')).toHaveLength(3);
  });

  it('refuses a child beyond maxChildren', async () => {
    const { runtimes } = setup({ policy: { ...parentPolicy, maxChildren: 1 } });
    const children = runtimes('tab-a');
    asChild(await children.createChildRuntime(ROOT, {}));
    expect(await children.createChildRuntime(ROOT, {})).toEqual({ refused: [expect.objectContaining({ code: 'policy-widening', path: 'children', value: 'maxChildren' })] });
  });

  it('after both are killed, the parent rediscovers the child by id and the child recovers on its own', async () => {
    const { runtimes, locks, booted, persisted } = setup();
    const before = asChild(await runtimes('tab-a').createChildRuntime(ROOT, { tools: ['env.fs.read'] }));
    const other = asChild(await runtimes('tab-a').createChildRuntime(ROOT, {}));
    // The second child's own state is lost: it fails to recover, and the first still does.
    persisted.delete(other.persistenceKey);
    locks.kill('tab-a');
    booted.length = 0;

    const { children, issues } = await runtimes('tab-b').rediscover(ROOT);
    expect(issues).toEqual([]);
    const recovered = asChild(children.find((child) => 'id' in child && child.id === before.id));
    expect(recovered).toMatchObject({ id: before.id, parentId: ROOT, depth: 1, policy: before.policy, namespace: before.namespace, persistenceKey: before.persistenceKey });
    expect(booted.find((context) => context.id === before.id)).toMatchObject({ recovering: true, persistenceKey: before.persistenceKey });
    expect(locks.heldBy(before.leaseKey)).toBe('tab-b');
    expect(children).toContainEqual({ failed: expect.objectContaining({ code: 'child-failed', childId: other.id, phase: 'boot' }) });
  });

  it('leaves a child another live tab owns to that tab', async () => {
    const { runtimes } = setup();
    const child = asChild(await runtimes('tab-a').createChildRuntime(ROOT, {}));
    expect(await runtimes('tab-b').rediscover(ROOT)).toEqual({ children: [{ ownedElsewhere: child.id }], issues: [] });
  });

  it('keeps a failing child at the child boundary; the parent stays ready', async () => {
    const parent = { id: ROOT, state: 'ready' as const };
    let late: ((error: unknown) => void) | undefined;
    const boot = vi.fn<ChildBoot>(async (context) => {
      if (context.policy.tools?.length === 1) throw new Error('child crashed while booting');
      late = context.fail;
      return {};
    });
    const { runtimes, events, hierarchy } = setup({ boot, onEvent: (event) => events.push(event) });
    const children = runtimes('tab-a');

    const result = await children.createChildRuntime(parent.id, { tools: ['env.fs.read'] });
    expect(result).toEqual({ failed: expect.objectContaining({ code: 'child-failed', parentId: ROOT, phase: 'boot', detail: 'child crashed while booting' }) });
    expect(parent.state).toBe('ready');
    expect(hierarchy.records.get(ROOT)).toMatchObject({ childIds: [] });

    const survivor = asChild(await children.createChildRuntime(parent.id, {}));
    expect(() => late!(new Error('child crashed later'))).not.toThrow();
    expect(survivor.state).toBe('failed');
    expect(parent.state).toBe('ready');
    expect(events.filter((event) => event.type === 'child-failed').map((event) => (event.type === 'child-failed' ? event.failure.phase : ''))).toEqual(['boot', 'run']);
  });

  it('fails a child at its lease, not the parent, without Web Locks (the default claimRuntimeLease)', async () => {
    const { runtimes, hierarchy } = setup();
    const result = await runtimes('tab-a', { claimLease: undefined }).createChildRuntime(ROOT, {});
    expect(result).toEqual({ failed: expect.objectContaining({ code: 'child-failed', phase: 'lease', error: expect.objectContaining({ name: 'DatabaseCoordinationError' }) }) });
    expect(hierarchy.records.get(ROOT)).toMatchObject({ childIds: [] });
  });

  it('reports a corrupt hierarchy record as a typed issue, not a crash', async () => {
    const { runtimes, hierarchy, events } = setup();
    const children = runtimes('tab-a');
    hierarchy.records.set(ROOT, { formatVersion: 1, environmentId: ROOT, parentId: null, childIds: 'everyone' });
    expect(await children.rediscover(ROOT)).toEqual({ children: [], issues: [{ code: 'hierarchy-corrupt', environmentId: ROOT, detail: expect.any(String) }] });
    expect(events).toContainEqual({ type: 'hierarchy-issue', issue: expect.objectContaining({ code: 'hierarchy-corrupt' }) });
    // Never overwritten by a new child.
    expect(await children.createChildRuntime(ROOT, {})).toEqual({ failed: expect.objectContaining({ code: 'child-failed', phase: 'persist' }) });

    hierarchy.records.set(ROOT, { formatVersion: 2, environmentId: ROOT, parentId: null, childIds: [] });
    expect((await children.rediscover(ROOT)).issues).toMatchObject([{ code: 'hierarchy-unsupported-version' }]);
  });

  it('recovers the sound children when one child record is corrupt or missing', async () => {
    const { runtimes, hierarchy, locks } = setup();
    const good = asChild(await runtimes('tab-a').createChildRuntime(ROOT, {}));
    const bad = asChild(await runtimes('tab-a').createChildRuntime(ROOT, {}));
    const gone = asChild(await runtimes('tab-a').createChildRuntime(ROOT, {}));
    locks.kill('tab-a');
    hierarchy.records.set(bad.id, 'garbage');
    hierarchy.records.delete(gone.id);

    const { children, issues } = await runtimes('tab-b').rediscover(ROOT);
    expect(children.map((child) => ('id' in child ? child.id : child))).toEqual([good.id]);
    expect(issues).toEqual([expect.objectContaining({ code: 'hierarchy-corrupt', environmentId: bad.id }), expect.objectContaining({ code: 'child-missing', environmentId: gone.id })]);
  });
});
