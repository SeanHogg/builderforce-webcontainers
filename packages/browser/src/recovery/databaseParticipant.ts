/**
 * A database recovery participant: the database owns its export. A checkpoint
 * stores `DatabaseControl.export()` (the Postgres data-directory tarball) under
 * the database's own key; recovery `import()`s it in place of the database's
 * data. The VFS checkpoint never carries these bytes.
 */
import { PERSISTED_FORMAT_VERSION } from '@seanhogg/builderforce-webcontainers-core';
import type { DatabaseControl } from '@seanhogg/builderforce-webcontainers-core/app';
import type { SnapshotStore } from '../snapshotStore.js';
import type { RecoveryParticipant } from './environmentRecovery.js';
import { identityRedact, loadRecord, saveRecord, type PersistedRecord, type Redact } from './persistedRecord.js';

export interface DatabaseParticipantOptions {
  /** The database service's id. */
  serviceId: string;
  /** Where its checkpoint is kept: one key per database. */
  key: string;
  /** The running database (`ApplicationRuntime.database(id)`); recovery imports into it, so it must be up by then. */
  database: () => DatabaseControl | Promise<DatabaseControl>;
  store: SnapshotStore;
  redact?: Redact;
  /** Default `database:<serviceId>`. */
  id?: string;
  dependsOn?: string[];
}

interface DatabaseRecord extends PersistedRecord {
  kind: 'database';
  serviceId: string;
  /** The export's MIME type, restored on the blob handed to `import()`. */
  type: string;
}

export function createDatabaseParticipant(options: DatabaseParticipantOptions): RecoveryParticipant {
  const id = options.id ?? `database:${options.serviceId}`;
  const redact = options.redact ?? identityRedact;
  return {
    id,
    stage: 'resources',
    dependsOn: options.dependsOn,
    async checkpoint() {
      const data = await (await options.database()).export();
      const record: DatabaseRecord = { formatVersion: PERSISTED_FORMAT_VERSION, kind: 'database', serviceId: options.serviceId, type: data.type };
      await saveRecord(options.store, options.key, record, [new Uint8Array(await data.arrayBuffer())], redact);
    },
    async recover() {
      const saved = await loadRecord<DatabaseRecord>(options.store, options.key);
      if (!saved) return { id, status: 'fresh' };
      const [data] = saved.payloads;
      if (!data) throw new Error(`The database checkpoint "${options.key}" has no export.`);
      // A payload is a view into the store's buffer, which may be shared; a Blob part needs its own `ArrayBuffer`.
      await (await options.database()).import(new Blob([new Uint8Array(data)], { type: saved.record.type }));
      return { id, status: 'restored' };
    },
  };
}
