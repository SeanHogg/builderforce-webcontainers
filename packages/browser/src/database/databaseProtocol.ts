/**
 * Messages between a page's database host (databaseHost.ts) and the database
 * it talks to — the database Worker in the tab that owns it, or, from another
 * tab, the owner tab over a BroadcastChannel (databaseTabs.ts). Client
 * connections are relayed as raw bytes (structured-cloned `Uint8Array`s, never
 * SharedArrayBuffer) with flow-control credits.
 */

export interface DatabaseOpenMessage {
  type: 'database-open';
  /** `idb://<name>` (persistent, IndexedDB) or `memory://`. */
  dataDir: string;
  /** Flush to IndexedDB after the reply instead of before it (faster, may lose the last writes on a crash). */
  relaxedDurability?: boolean;
  /** Where the Worker imports PGlite from (an ES module URL). */
  pgliteUrl?: string;
  /** Cut off a connection that holds the engine idle (in a transaction) this long. 0 = never. */
  idleInTransactionTimeoutMs?: number;
}

export type DatabaseOperation =
  | { op: 'export' }
  | { op: 'import'; data: Blob }
  | { op: 'reset' }
  | { op: 'query'; sql: string }
  | { op: 'close' };

/** page → database */
export type ToDatabase =
  | DatabaseOpenMessage
  | { type: 'db-call'; callId: number; operation: DatabaseOperation }
  | { type: 'db-conn-open'; connId: number }
  | { type: 'db-conn-data'; connId: number; data: Uint8Array }
  | { type: 'db-conn-ack'; connId: number; bytes: number }
  | { type: 'db-conn-close'; connId: number };

/** database → page */
export type FromDatabase =
  | { type: 'db-ready'; serverVersion: string }
  | { type: 'db-failed'; message: string }
  | { type: 'db-log'; text: string }
  /** The database behind a tab link changed owner: every connection and call through it is gone. */
  | { type: 'db-reset' }
  | { type: 'db-result'; callId: number; ok: true; value?: unknown }
  | { type: 'db-result'; callId: number; ok: false; message: string }
  | { type: 'db-conn-data'; connId: number; data: Uint8Array }
  | { type: 'db-conn-ack'; connId: number; bytes: number }
  | { type: 'db-conn-close'; connId: number };

/** One side's view of the database it talks to. */
export interface DatabaseLink {
  post(message: ToDatabase): void;
  onMessage(listener: (message: FromDatabase) => void): void;
  /** Stop talking (and, for a Worker, stop it). */
  close(): void;
}

/** Is this the message that turns a fresh process Worker into a database Worker? */
export function isDatabaseOpen(message: unknown): message is DatabaseOpenMessage {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'database-open';
}
