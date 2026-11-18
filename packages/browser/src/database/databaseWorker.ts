/**
 * The database Worker: the one authoritative owner of a project database. It
 * opens PGlite (IndexedDB-backed for a persistent database, in memory
 * otherwise), serves the Postgres wire gateway on every client connection the
 * page relays to it, serializes them onto PGlite's single session
 * (engineScheduler.ts), and performs export / import / reset between their
 * transactions. An import is loaded and checked in a scratch in-memory PGlite
 * first: a bad snapshot is refused and the current data stays. No worker
 * globals in here — `post` and PGlite are injected — so the same code runs in a
 * real Worker and in-thread in tests.
 */
import { createChannelPair } from '@seanhogg/builderforce-webcontainers-core';
import { createEngineScheduler } from './engineScheduler.js';
import { serveGatewayConnection, type GatewayConnection } from './pgGateway.js';
import { RelayedChannels } from '../node/relayedChannels.js';
import type { DatabaseOpenMessage, DatabaseOperation, FromDatabase, ToDatabase } from './databaseProtocol.js';
import type { OpenPGlite, PGliteLike } from './pgliteLoader.js';

export interface DatabaseWorkerDeps {
  post(message: FromDatabase): void;
  /** Open PGlite (`pgliteFrom(url)` in a real Worker). Receives the open message's `pgliteUrl`. */
  openPGlite(pgliteUrl: string | undefined): OpenPGlite;
  /** Remove a persistent database's stored files (`deletePgliteStorage`). */
  deleteStorage(dataDir: string): Promise<void>;
}

/** Server parameters a client hears at start-up, read from the engine. */
const ANNOUNCED = ['server_version', 'server_encoding', 'client_encoding', 'DateStyle', 'IntervalStyle', 'TimeZone', 'integer_datetimes', 'standard_conforming_strings'];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createDatabaseWorker(deps: DatabaseWorkerDeps): { receive(message: ToDatabase): void } {
  let settings!: DatabaseOpenMessage;
  let open!: OpenPGlite;
  let db: Promise<PGliteLike> = new Promise(() => undefined);
  let parameters: Record<string, string> = {};
  let ready: Promise<void> = new Promise(() => undefined);
  let isReady = false;
  let scheduler!: ReturnType<typeof createEngineScheduler>;
  /** Our ends of the client connections, relayed to the page. */
  const clients = new RelayedChannels('db-conn', deps.post);
  const gateways = new Map<number, GatewayConnection>();
  let nextProcessId = 1000;

  const log = (text: string) => deps.post({ type: 'db-log', text });

  const start = (loadDataDir?: Blob): Promise<PGliteLike> => {
    const startedAt = Date.now();
    const opening = open({ dataDir: settings.dataDir, relaxedDurability: settings.relaxedDurability, loadDataDir });
    db = opening;
    return opening.then((instance) => {
      log(`PGlite ready (${settings.dataDir}) in ${Date.now() - startedAt}ms.`);
      return instance;
    });
  };

  /** Hang up on every client: an import, a reset or a close replaces what they were talking to. */
  const dropConnections = () => {
    for (const gateway of gateways.values()) gateway.close();
    gateways.clear();
  };

  /** A snapshot that a scratch PGlite can open and query; throws otherwise, touching nothing. */
  const check = async (data: Blob) => {
    let scratch: PGliteLike | undefined;
    try {
      scratch = await open({ dataDir: 'memory://', loadDataDir: data });
      await scratch.query('SELECT 1');
    } catch (error) {
      throw new Error(`Not a usable database snapshot: ${messageOf(error)}`);
    } finally {
      await scratch?.close().catch(() => undefined);
    }
  };

  /** Swap the data for `data` (or empty); if the new data will not open, the old comes back. */
  const replace = async (data?: Blob) => {
    if (data) await check(data);
    dropConnections();
    const old = await db.catch(() => undefined);
    const backup = await old?.dumpDataDir('auto').catch(() => undefined);
    await old?.close().catch(() => undefined);
    await deps.deleteStorage(settings.dataDir);
    try {
      await start(data);
    } catch (error) {
      log(`Could not open the new data (${messageOf(error)}); restoring the previous data.`);
      await deps.deleteStorage(settings.dataDir).catch(() => undefined);
      await start(backup);
      throw error;
    }
  };

  const operations: { [K in DatabaseOperation['op']]: (operation: Extract<DatabaseOperation, { op: K }>) => Promise<unknown> } = {
    export: () => scheduler.exclusive(async () => (await db).dumpDataDir('auto')),
    import: ({ data }) => scheduler.exclusive(() => replace(data)),
    reset: () => scheduler.exclusive(() => replace()),
    query: ({ sql }) => scheduler.exclusive(async () => (await (await db).query(sql)).rows),
    close: () =>
      scheduler.exclusive(async () => {
        dropConnections();
        await (await db).close();
      }),
  };
  const call = (operation: DatabaseOperation): Promise<unknown> => (operations[operation.op] as (operation: DatabaseOperation) => Promise<unknown>)(operation);

  /** Run once PGlite is open, in arrival order. */
  const whenReady = (fn: () => void) => (isReady ? fn() : void ready.then(fn));

  const connect = (connId: number) => {
    const [ours, gatewayEnd] = createChannelPair();
    clients.add(connId, ours);
    gateways.set(connId, serveGatewayConnection({ channel: gatewayEnd, scheduler, parameters, processId: nextProcessId++ }));
    gatewayEnd.onClose(() => gateways.delete(connId));
  };

  const openDatabase = (message: DatabaseOpenMessage) => {
    settings = message;
    open = deps.openPGlite(message.pgliteUrl);
    scheduler = createEngineScheduler(
      async () => {
        const instance = await db;
        return { exec: (messages) => instance.execProtocolRaw(messages) };
      },
      { idleInTransactionTimeoutMs: message.idleInTransactionTimeoutMs },
    );
    ready = start().then(async (instance) => {
      const rows = (await instance.query<{ name: string; setting: string }>(`SELECT name, setting FROM pg_settings WHERE name IN (${ANNOUNCED.map((name) => `'${name}'`).join(', ')})`)).rows;
      Object.assign(parameters, Object.fromEntries(rows.map((row) => [row.name, row.setting])), { is_superuser: 'on', session_authorization: 'postgres' });
      isReady = true;
      deps.post({ type: 'db-ready', serverVersion: parameters.server_version ?? '' });
    });
    ready.catch((error: unknown) => deps.post({ type: 'db-failed', message: messageOf(error) }));
  };

  return {
    receive(message) {
      switch (message.type) {
        case 'database-open':
          return openDatabase(message);
        case 'db-conn-open':
          return whenReady(() => connect(message.connId));
        case 'db-conn-data':
        case 'db-conn-ack':
        case 'db-conn-close':
          return whenReady(() => clients.receive(message));
        case 'db-call':
          return whenReady(() => {
            call(message.operation).then(
              (value) => deps.post({ type: 'db-result', callId: message.callId, ok: true, value }),
              (error: unknown) => deps.post({ type: 'db-result', callId: message.callId, ok: false, message: messageOf(error) }),
            );
          });
      }
    },
  };
}
