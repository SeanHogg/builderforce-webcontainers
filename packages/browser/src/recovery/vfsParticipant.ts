/**
 * The VFS recovery participant. A checkpoint is `VfsSnapshots.snapshot()` —
 * the cached pack plus the journal's ops since it (`VfsJournal.since`) —
 * stored as one record; recovery mounts the pack into the new tab's (empty)
 * file system and replays those ops (`mountSnapshot`). The pack and each
 * written file's contents travel as payloads; the record lists the ops. A
 * database's bytes never pass through here: each database participant owns its
 * own export.
 */
import { mountSnapshot, PERSISTED_FORMAT_VERSION, type FileContent, type VfsOp, type VfsSnapshots, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import type { SnapshotStore } from '../snapshotStore.js';
import type { RecoveryParticipant } from './environmentRecovery.js';
import { identityRedact, loadRecord, saveRecord, type PersistedRecord, type Redact } from './persistedRecord.js';

export interface VfsParticipantOptions {
  /** Where the checkpoint is kept (the environment's id, say). */
  key: string;
  /** The file system recovery mounts into: the new tab's, still empty. */
  fs: VirtualFileSystem;
  /** Snapshots of the live file system. */
  snapshots: Pick<VfsSnapshots, 'snapshot'>;
  store: SnapshotStore;
  redact?: Redact;
  /** Default `vfs`. */
  id?: string;
}

/** A recorded op; a write's contents are payload `payload` (text when `text`). */
type RecordedOp = { op: 'write'; path: string; payload: number; text: boolean } | { op: 'remove' | 'mkdir'; path: string };

interface VfsRecord extends PersistedRecord {
  kind: 'vfs';
  /** The journal sequence the file system is current at once mounted. */
  seq: number;
  ops: RecordedOp[];
}

const encoder = new TextEncoder();
/** Keeps a leading BOM: a text file comes back exactly as it was written. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
/** Payload 0 is the pack; written contents follow. */
const PACK_PAYLOAD = 0;

export function createVfsParticipant(options: VfsParticipantOptions): RecoveryParticipant {
  const id = options.id ?? 'vfs';
  const redact = options.redact ?? identityRedact;
  return {
    id,
    stage: 'vfs',
    async checkpoint() {
      const snapshot = options.snapshots.snapshot();
      const payloads = [new Uint8Array(snapshot.pack)];
      const ops = snapshot.ops.map((op): RecordedOp => {
        if (op.op !== 'write') return op;
        const content = op.content;
        const text = typeof content === 'string';
        payloads.push(text ? encoder.encode(content) : content);
        return { op: 'write', path: op.path, payload: payloads.length - 1, text };
      });
      await saveRecord<VfsRecord>(options.store, options.key, { formatVersion: PERSISTED_FORMAT_VERSION, kind: 'vfs', seq: snapshot.seq, ops }, payloads, redact);
    },
    async recover() {
      const saved = await loadRecord<VfsRecord>(options.store, options.key);
      if (!saved) return { id, status: 'fresh' };
      const { record, payloads } = saved;
      const payload = (index: number) => {
        const bytes = payloads[index];
        if (!bytes) throw new Error(`The VFS checkpoint "${options.key}" lacks payload ${index}.`);
        return bytes;
      };
      const ops = record.ops.map((op): VfsOp => {
        if (op.op !== 'write') return op;
        const content: FileContent = op.text ? decoder.decode(payload(op.payload)) : payload(op.payload);
        return { op: 'write', path: op.path, content };
      });
      const pack = payload(PACK_PAYLOAD);
      mountSnapshot(options.fs, { pack: pack.buffer.slice(pack.byteOffset, pack.byteOffset + pack.byteLength) as ArrayBuffer, ops, seq: record.seq });
      return { id, status: 'restored' };
    },
  };
}
