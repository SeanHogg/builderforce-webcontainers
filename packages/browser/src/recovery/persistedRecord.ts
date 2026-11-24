/**
 * How a recovery participant persists what it checkpointed: one zip per key in
 * a snapshot store, holding the participant's record (JSON, stamped with
 * `PERSISTED_FORMAT_VERSION` and passed through the host's `redact` port) and
 * its opaque payloads (a VFS pack, a database tarball) as numbered binary
 * entries. Payloads are bytes the participant owns and are stored as given;
 * only the record is redacted.
 */
import { exportZip, importZip, PERSISTED_FORMAT_VERSION, VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { createSnapshotStore, type SnapshotStore } from '../snapshotStore.js';

/** Scrubs secrets from a record before it is persisted (Builderforce passes `redactDeep`). */
export type Redact = <T>(record: T) => T;
export const identityRedact: Redact = (record) => record;

/** Every persisted record carries the format it was written in. */
export interface PersistedRecord {
  formatVersion: typeof PERSISTED_FORMAT_VERSION;
}

export interface Persisted<R extends PersistedRecord> {
  record: R;
  payloads: Uint8Array[];
}

/** A participant's checkpoint was not stored (storage full or unavailable). */
export class RecoveryStorageError extends Error {
  constructor(readonly key: string) {
    super(`The checkpoint "${key}" was not stored: storage is full or unavailable.`);
    this.name = 'RecoveryStorageError';
  }
}

/** Checkpoints kept before the least recently used is dropped: a VFS plus many databases, never evicted in normal use. */
export const RECOVERY_STORE_ENTRIES = 64;

/** The default store for checkpoints: its own database, so it never competes with `node_modules` snapshots. */
export const createRecoveryStore = (): SnapshotStore => createSnapshotStore({ name: 'bfwc-recovery', maxEntries: RECOVERY_STORE_ENTRIES });

const RECORD_PATH = '/record.json';
const payloadPath = (index: number) => `/payload/${index}`;
/**
 * Leads every payload entry: 0xFF never occurs in UTF-8, so `importZip` hands
 * the entry back as bytes (it decodes valid UTF-8 to text, which would drop a
 * leading BOM) and the payload round-trips exactly.
 */
const BINARY_MARK = 0xff;

function markBinary(bytes: Uint8Array): Uint8Array {
  const marked = new Uint8Array(bytes.byteLength + 1);
  marked[0] = BINARY_MARK;
  marked.set(bytes, 1);
  return marked;
}

/** Redact `record` and store it with `payloads` under `key`; throws `RecoveryStorageError` when the store refused it. */
export async function saveRecord<R extends PersistedRecord>(store: SnapshotStore, key: string, record: R, payloads: readonly Uint8Array[], redact: Redact): Promise<void> {
  const fs = new VirtualFileSystem();
  fs.writeFile(RECORD_PATH, JSON.stringify(redact(record)));
  payloads.forEach((bytes, index) => fs.writeFile(payloadPath(index), markBinary(bytes)));
  if (!(await store.save(key, exportZip(fs)))) throw new RecoveryStorageError(key);
}

/** What `saveRecord` stored under `key`, or undefined when nothing was. Throws for a record of another format. */
export async function loadRecord<R extends PersistedRecord>(store: SnapshotStore, key: string): Promise<Persisted<R> | undefined> {
  const zip = await store.load(key);
  if (!zip) return undefined;
  const fs = new VirtualFileSystem();
  importZip(fs, zip);
  const text = fs.readFile(RECORD_PATH);
  if (typeof text !== 'string') throw new Error(`The checkpoint "${key}" has no readable record.`);
  const record = JSON.parse(text) as R;
  if (record.formatVersion !== PERSISTED_FORMAT_VERSION) throw new Error(`The checkpoint "${key}" is format ${record.formatVersion}; this runtime reads format ${PERSISTED_FORMAT_VERSION}.`);
  const payloads: Uint8Array[] = [];
  for (let content = fs.readFile(payloadPath(0)); content !== undefined; content = fs.readFile(payloadPath(payloads.length))) {
    if (typeof content === 'string' || content[0] !== BINARY_MARK) throw new Error(`The checkpoint "${key}" has a damaged payload ${payloads.length}.`);
    payloads.push(content.subarray(1));
  }
  return { record, payloads };
}
