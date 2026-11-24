/**
 * Suspend → recover: a tab killed without a stop comes back in a new tab — the
 * same files, its database rows (through the database participant, never the
 * VFS checkpoint), its services ready — and only the lease owner, holding a
 * current fencing token, may checkpoint or recover.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { VfsSnapshots, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { ApplicationSpec, DatabaseControl } from '@seanhogg/builderforce-webcontainers-core/app';
import { createSnapshotStore, type SnapshotStore } from '../../src/snapshotStore.js';
import { claimRuntimeLease, indexedDbLeaseTokenStore, type RuntimeLease } from '../../src/shared/runtimeLease.js';
import {
  capabilityParticipants,
  createDatabaseParticipant,
  createEnvironmentRecovery,
  createServiceParticipant,
  createVfsParticipant,
  RecoveryCheckpointError,
  RecoveryLeaseError,
  type RecoveryParticipant,
} from '../../src/recovery.js';
import type { ApplicationRuntime, ServiceSnapshot } from '../../src/app/types.js';
import { fakeLocks } from '../databaseHelpers.js';

/** One browser origin: its IndexedDB (checkpoints and fencing tokens) and its Web Locks, shared by its tabs. */
function origin() {
  const indexedDB = new IDBFactory();
  const saves: Array<{ key: string; zip: Uint8Array }> = [];
  const snapshots = createSnapshotStore({ indexedDB });
  const store: SnapshotStore = { ...snapshots, save: (key, zip) => (saves.push({ key, zip }), snapshots.save(key, zip)) };
  return { indexedDB, store, saves, locks: fakeLocks(), tokens: indexedDbLeaseTokenStore(indexedDB) };
}

const DB_MARKER = 'ROWS-OF-THE-DATABASE';
/** A database whose export is its rows as JSON (with a marker to find the bytes by). */
function fakeDatabase(rows: string[] = []) {
  const control: DatabaseControl = {
    export: async () => new Blob([JSON.stringify({ marker: DB_MARKER, rows })], { type: 'application/x-tar' }),
    import: async (data) => {
      rows.splice(0, rows.length, ...(JSON.parse(await data.text()) as { rows: string[] }).rows);
    },
    reset: async () => {
      rows.length = 0;
    },
  };
  return { rows, control };
}

/** A runtime whose services all come up `ready` on `start()`. */
function fakeRuntime(ids: string[]) {
  let started = false;
  const runtime = {
    start: async () => {
      started = true;
    },
    listServices: () => ids.map((id) => ({ id, state: started ? 'ready' : 'discovered' }) as ServiceSnapshot),
  };
  return runtime as unknown as ApplicationRuntime;
}

const spec = { services: [] } as unknown as ApplicationSpec;
/** Resolves once `lease` is owned: a released lock reaches the next tab a moment later. */
const ownership = (lease: RuntimeLease) => (lease.state.kind === 'owner' ? Promise.resolve() : new Promise<void>((resolve) => lease.onOwner(resolve)));
const hashes = (fs: VirtualFileSystem) => Object.fromEntries(fs.list().map((path) => [path, createHash('sha256').update(fs.readFile(path)!).digest('hex')]));
const contains = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

/** One tab's environment: its file system, database, services and lease. */
async function tab(at: ReturnType<typeof origin>, options: { rows?: string[]; durability?: 'ephemeral' | 'local'; extra?: RecoveryParticipant[]; database?: DatabaseControl } = {}) {
  const fs = new VirtualFileSystem();
  const database = fakeDatabase(options.rows);
  const lease = await claimRuntimeLease(at.locks, 'env:project', at.tokens);
  const started: ApplicationRuntime[] = [];
  const participants = [
    // Out of order on purpose: the coordinator orders by stage.
    createServiceParticipant({ spec, runtimeOptions: {} as never, start: () => fakeRuntime(['db', 'api']), onRuntime: (runtime) => started.push(runtime) }),
    createDatabaseParticipant({ serviceId: 'db', key: 'project:db', database: () => options.database ?? database.control, store: at.store }),
    createVfsParticipant({ key: 'project:vfs', fs, snapshots: new VfsSnapshots(fs), store: at.store }),
    ...(options.extra ?? []),
  ];
  const recovery = createEnvironmentRecovery({ participants, durability: options.durability ?? 'local', lease });
  return { fs, database, lease, recovery, started };
}

describe('environment recovery', () => {
  it('recovers a tab killed without a stop: files, database rows and ready services', async () => {
    const at = origin();
    const first = await tab(at, { rows: ['alice', 'bob'] });
    first.fs.writeFile('/src/index.ts', 'export const answer = 42;\n');
    first.fs.writeFile('/bom.txt', '﻿with a byte order mark');
    first.fs.writeFile('/logo.bin', new Uint8Array([0xff, 0x00, 0xd8, 0x80]));
    first.fs.mkdir('/empty');
    await first.recovery.checkpoint();
    // Edits after the pack: they travel as journal ops.
    first.fs.writeFile('/src/index.ts', 'export const answer = 43;\n');
    first.fs.rm('/bom.txt');
    first.fs.writeFile('/notes.md', '# notes');
    first.database.rows.push('carol');
    await first.recovery.checkpoint();
    const expected = hashes(first.fs);

    // Killed: no stop, nothing flushed; the browser drops the dead tab's lock.
    first.lease.release();
    const second = await tab(at);
    await ownership(second.lease);
    expect(second.lease.state.kind).toBe('owner');

    expect(await second.recovery.recover()).toEqual([
      { id: 'vfs', status: 'restored' },
      { id: 'database:db', status: 'restored' },
      { id: 'services', status: 'restored' },
    ]);
    expect(hashes(second.fs)).toEqual(expected);
    expect(second.fs.isDirectory('/empty')).toBe(true);
    expect(second.database.rows).toEqual(['alice', 'bob', 'carol']);
    expect(second.started[0]!.listServices().map((service) => service.state)).toEqual(['ready', 'ready']);

    // The database owns its export: the VFS checkpoint never carried its bytes.
    const vfsSaves = at.saves.filter((save) => save.key === 'project:vfs');
    const dbSaves = at.saves.filter((save) => save.key === 'project:db');
    expect(vfsSaves).toHaveLength(2);
    expect(vfsSaves.some((save) => contains(save.zip, DB_MARKER))).toBe(false);
    expect(dbSaves).toHaveLength(2);
  });

  it('gives one tab the lease and the other owned-elsewhere; a stale fencing token fails the fence', async () => {
    const at = origin();
    const a = await claimRuntimeLease(at.locks, 'env:x', at.tokens);
    const b = await claimRuntimeLease(at.locks, 'env:x', at.tokens);
    expect([a.state.kind, b.state.kind]).toEqual(['owner', 'owned-elsewhere']);
    const stale = a.state.kind === 'owner' ? a.state.fencingToken : -1;
    expect(a.assertFence(stale)).toBe(true);

    const handedOver = new Promise<void>((resolve) => b.onOwner(resolve));
    a.release();
    await handedOver;
    expect(b.state).toEqual({ kind: 'owner', fencingToken: stale + 1 });
    expect(a.assertFence(stale)).toBe(false);
    expect(b.assertFence(stale)).toBe(false);
    expect(b.assertFence(stale + 1)).toBe(true);
    b.release();

    // The token outlives the page: a reopened store continues the sequence.
    const reopened = await claimRuntimeLease(at.locks, 'env:x', indexedDbLeaseTokenStore(at.indexedDB));
    await ownership(reopened);
    expect(reopened.state).toEqual({ kind: 'owner', fencingToken: stale + 2 });
    reopened.release();
  });

  it('refuses to run without the lease, and stops once the lease is lost', async () => {
    const at = origin();
    const owner = await tab(at);
    const follower = await tab(at);
    await expect(follower.recovery.recover()).rejects.toBeInstanceOf(RecoveryLeaseError);
    await expect(follower.recovery.checkpoint()).rejects.toBeInstanceOf(RecoveryLeaseError);

    const releasing: RecoveryParticipant = { id: 'loses-lease', stage: 'vfs', checkpoint: async () => owner.lease.release(), recover: async () => ({ id: 'loses-lease', status: 'fresh' }) };
    const losing = createEnvironmentRecovery({ participants: [releasing, createVfsParticipant({ key: 'k', fs: owner.fs, snapshots: new VfsSnapshots(owner.fs), store: at.store })], durability: 'local', lease: owner.lease });
    await expect(losing.checkpoint()).rejects.toBeInstanceOf(RecoveryLeaseError);
    expect(at.saves).toEqual([]);
    follower.lease.release();
  });

  it('persists and recovers nothing for an ephemeral environment', async () => {
    const at = origin();
    const ephemeral = await tab(at, { durability: 'ephemeral', rows: ['x'] });
    ephemeral.fs.writeFile('/a.txt', 'a');
    await ephemeral.recovery.checkpoint();
    expect(at.saves).toEqual([]);
    expect(await ephemeral.recovery.recover()).toEqual([
      { id: 'vfs', status: 'skipped' },
      { id: 'database:db', status: 'skipped' },
      { id: 'services', status: 'skipped' },
    ]);
    expect(ephemeral.started).toEqual([]);
    ephemeral.lease.release();
  });

  it('fails a database whose export throws, and still runs the later stages', async () => {
    const at = origin();
    const ran: string[] = [];
    const agents: RecoveryParticipant = {
      id: 'agents',
      stage: 'capabilities',
      checkpoint: async () => void ran.push('checkpoint'),
      recover: async () => (ran.push('recover'), { id: 'agents', status: 'fresh' }),
    };
    const broken: DatabaseControl = {
      export: () => Promise.reject(new Error('export failed: disk I/O')),
      import: () => Promise.reject(new Error('import failed: not running')),
      reset: async () => undefined,
    };
    const env = await tab(at, { database: broken, extra: [agents] });
    const failure = await env.recovery.checkpoint().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecoveryCheckpointError);
    expect((failure as RecoveryCheckpointError).failures).toEqual([{ id: 'database:db', status: 'failed', detail: 'export failed: disk I/O' }]);
    expect(ran).toEqual(['checkpoint']);
    expect(at.saves.map((save) => save.key)).toEqual(['project:vfs']);

    const results = await env.recovery.recover();
    expect(results.map((result) => [result.id, result.status])).toEqual([
      ['vfs', 'restored'],
      ['database:db', 'fresh'],
      ['services', 'restored'],
      ['agents', 'fresh'],
    ]);
    expect(ran).toEqual(['checkpoint', 'recover']);
    env.lease.release();
  });

  it('reports a checkpoint the store refused (quota) as failed, with the reason', async () => {
    const at = origin();
    const full: SnapshotStore = { ...at.store, save: async () => false };
    const fs = new VirtualFileSystem();
    fs.writeFile('/a.txt', 'a');
    const lease = await claimRuntimeLease(at.locks, 'env:quota', at.tokens);
    const recovery = createEnvironmentRecovery({ participants: [createVfsParticipant({ key: 'q', fs, snapshots: new VfsSnapshots(fs), store: full })], durability: 'local', lease });
    const failure = (await recovery.checkpoint().catch((error: unknown) => error)) as RecoveryCheckpointError;
    expect(failure.failures).toEqual([{ id: 'vfs', status: 'failed', detail: expect.stringMatching(/not stored: storage is full/) }]);
    lease.release();
  });

  it('orders by stage, then dependencies, and rejects a dependency on a later stage', async () => {
    const at = origin();
    const lease = await claimRuntimeLease(at.locks, 'env:order', at.tokens);
    const order: string[] = [];
    const participant = (id: string, stage: RecoveryParticipant['stage'], dependsOn?: string[]): RecoveryParticipant => ({
      id,
      stage,
      dependsOn,
      checkpoint: async () => undefined,
      recover: async () => (order.push(id), { id, status: 'fresh' }),
    });
    const participants = [participant('cache', 'resources', ['db']), participant('api', 'services'), participant('db', 'resources', ['files']), participant('files', 'vfs')];
    await createEnvironmentRecovery({ participants, durability: 'local', lease }).recover();
    expect(order).toEqual(['files', 'db', 'cache', 'api']);
    expect(() => createEnvironmentRecovery({ participants: [participant('files', 'vfs', ['api']), participant('api', 'services')], durability: 'local', lease })).toThrow(/later stage/);
    lease.release();
  });

  it('records no capabilities participant for a manifest without the agents capability', () => {
    const agents = vi.fn((): RecoveryParticipant => ({ id: 'agents', stage: 'capabilities', checkpoint: async () => undefined, recover: async () => ({ id: 'agents', status: 'fresh' }) }));
    expect(capabilityParticipants({}, { agents })).toEqual([]);
    expect(capabilityParticipants({ capabilities: { other: {} } }, { agents })).toEqual([]);
    expect(agents).not.toHaveBeenCalled();
    expect(capabilityParticipants({ capabilities: { agents: {} } }, { agents }).map((participant) => participant.stage)).toEqual(['capabilities']);
  });
});
