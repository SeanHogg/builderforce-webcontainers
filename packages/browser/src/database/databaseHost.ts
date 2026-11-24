/**
 * The page side of one database. It puts the Postgres gateway on a virtual TCP
 * port and relays every client connection, as raw bytes, to the database:
 *
 * - owner: this tab runs the database Worker (on the HOST origin — never the
 *   preview origin, so code a project runs has no path to its storage), and
 *   serves the project's other tabs through it (databaseTabs.ts);
 * - follower: another tab owns a persistent database; this tab proxies to it
 *   and waits in line (databaseLeadership.ts). When the owner goes, the next
 *   tab in line takes over from IndexedDB; clients of the tabs that did not
 *   own it see their connections close, and reconnect.
 *
 * It does no database work itself: PGlite, the wire protocol and the
 * scheduling all run in the Worker. What it does decide is who gets in: each
 * connection is authenticated here, against this tab's logins and the caller
 * the port registry names, before it is relayed (pgAuthentication.ts).
 */
import type { ByteChannel, ConnectionHandler, SecurityContext, ShieldReasonCode } from '@seanhogg/builderforce-webcontainers-core';
import { authenticateConnection, type ConnectionAuthenticator } from './pgAuthentication.js';
import type { DatabaseControl } from '@seanhogg/builderforce-webcontainers-core/app';
import type { WorkerLike } from '../node/processHost.js';
import { RelayedChannels } from '../node/relayedChannels.js';
import type { DatabaseLink, DatabaseOperation, FromDatabase } from './databaseProtocol.js';
import { createLinkMux, workerLink } from './databaseLink.js';
import { claimDatabase, type DatabaseOwnership, type LockManagerLike } from './databaseLeadership.js';
import { followerLink, newTabId, serveFollowerTabs, type ChannelFactory } from './databaseTabs.js';

export interface DatabaseHostOptions {
  /** The database Worker, started on the host origin (`PreviewRuntime.createDatabaseWorker`). */
  createWorker(): WorkerLike;
  /** Put a raw-TCP listener on the runtime's virtual network (`PreviewRuntime.listenTcp`), owned by `owner`; throws `EADDRINUSE`. */
  listen(port: number, accept: ConnectionHandler, owner?: SecurityContext): { port: number; close(): void };
  port: number;
  /** Who owns the database's port: the (application, database service) the runtime minted. Omitted, the platform. */
  owner?: SecurityContext;
  /**
   * Admits each client connection, on this page, before any of it reaches the
   * database (pgAuthentication.ts): the pglite provider's generated logins and
   * service graph (`databaseAuthenticator`). Required: there is no trust mode.
   */
  authenticate: ConnectionAuthenticator;
  /**
   * A connection was refused (telemetry; never changes the outcome). `caller` is
   * who the port registry says dialled; `detail` is what the client asked for
   * (the database name, and its self-declared `application_name` — a claim, never an identity).
   */
  onRefused?(reason: ShieldReasonCode, caller: SecurityContext | undefined, detail?: { database?: string; claimedApplicationName?: string }): void;
  /** `idb://<key>` (persistent, shared by the origin's tabs) or `memory://`. */
  dataDir: string;
  /** Default `navigator.locks`. Required for a persistent database. */
  locks?: LockManagerLike;
  /** Default `globalThis.BroadcastChannel`: how tabs reach the owner. */
  BroadcastChannel?: ChannelFactory;
  relaxedDurability?: boolean;
  pgliteUrl?: string;
  /** Cut off a connection idle inside a transaction after this long (default 30000ms; 0 = never). */
  idleInTransactionTimeoutMs?: number;
  /** How long `close()` waits for PGlite to flush and close before terminating the Worker. Default 5000ms. */
  closeTimeoutMs?: number;
  /** A line about the database (it started, it moved tabs). */
  log?(text: string): void;
}

export interface DatabaseHost extends DatabaseControl {
  readonly port: number;
  /** `owner` runs the database in this tab; `follower` proxies to the tab that does. */
  readonly role: 'owner' | 'follower';
  /** Resolves once the database is open (here or in the owner tab); rejects when it fails to start. */
  readonly booted: Promise<void>;
  /** Run SQL with the engine to itself (between client transactions); resolves with the rows. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  /** Close every connection, close PGlite (flushed; `terminate()` after `closeTimeoutMs`), release the database; resolves once it is free to claim again. */
  close(): Promise<void>;
  /** Stop at once: terminate the Worker, release the database. PGlite does not get to flush. */
  terminate(): void;
  /** Resolves with 0 once closed, 1 when the database failed, 137 when terminated (after the database is released). */
  readonly closed: Promise<number>;
}

const defaultLocks = () => (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;

export async function startDatabaseHost(options: DatabaseHostOptions): Promise<DatabaseHost> {
  const persistent = options.dataDir.startsWith('idb://');
  const key = options.dataDir.slice('idb://'.length);
  const Channel = options.BroadcastChannel ?? globalThis.BroadcastChannel;
  const ownership: DatabaseOwnership | undefined = persistent ? await claimDatabase(options.locks ?? defaultLocks(), key) : undefined;
  const tabId = newTabId();

  let link: DatabaseLink | undefined;
  let worker: WorkerLike | undefined;
  let tabs: { close(): void } | undefined;
  let role: 'owner' | 'follower' = 'follower';
  const clients = new RelayedChannels('db-conn', (message) => link?.post(message));
  const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextConn = 1;
  let nextCall = 1;
  let ended = false;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => (resolveClosed = resolve));
  let booted!: { resolve(): void; reject(error: Error): void };
  const bootedPromise = new Promise<void>((resolve, reject) => (booted = { resolve, reject }));
  bootedPromise.catch(() => undefined);

  /** Connections still authenticating: not yet relayed, but hung up on with the rest. */
  const authenticating = new Set<{ cancel(): void }>();
  const accept = (socket: ByteChannel, caller?: SecurityContext) => {
    if (ended) return socket.close();
    const pending = authenticateConnection({
      socket,
      caller,
      authenticate: options.authenticate,
      refused: (reason, request) => {
        authenticating.delete(pending);
        try {
          options.onRefused?.(reason, caller, { database: request?.database, claimedApplicationName: request?.applicationName });
        } catch {
          // telemetry fails open
        }
      },
      accepted: (forward) => {
        authenticating.delete(pending);
        if (ended) return socket.close();
        const connId = nextConn++;
        clients.add(connId, socket);
        link?.post({ type: 'db-conn-open', connId });
        link?.post({ type: 'db-conn-data', connId, data: forward });
      },
    });
    authenticating.add(pending);
    socket.onClose(() => authenticating.delete(pending));
  };
  const hangUpAuthenticating = () => {
    for (const pending of [...authenticating]) pending.cancel();
    authenticating.clear();
  };
  let registration: { port: number; close(): void };
  try {
    registration = options.listen(options.port, accept, options.owner);
  } catch (error) {
    ownership?.release();
    throw error;
  }

  /** Every client and call through the current link is gone (the owner changed, or this host stops). */
  const dropAll = (reason: string) => {
    clients.closeAll();
    for (const call of calls.values()) call.reject(new Error(reason));
    calls.clear();
  };

  const handle = (message: FromDatabase) => {
    switch (message.type) {
      case 'db-ready':
        return booted.resolve();
      case 'db-failed':
        options.log?.(`PGlite failed to start: ${message.message}`);
        booted.reject(new Error(message.message));
        return role === 'owner' ? void end(1, message.message) : undefined;
      case 'db-log':
        return options.log?.(message.text);
      case 'db-reset':
        options.log?.('The tab that owned the database closed it; reconnecting through the next owner.');
        return dropAll('The database moved to another tab.');
      case 'db-result': {
        const pending = calls.get(message.callId);
        calls.delete(message.callId);
        return message.ok ? pending?.resolve(message.value) : pending?.reject(new Error(message.message));
      }
      default:
        return clients.receive(message);
    }
  };

  const attach = (next: DatabaseLink) => {
    link?.close();
    dropAll('The database moved to another tab.');
    link = next;
    next.onMessage((message) => link === next && handle(message));
  };

  const becomeOwner = () => {
    if (ended) return;
    role = 'owner';
    worker = options.createWorker();
    worker.onerror = (event) => {
      options.log?.(`The database Worker failed: ${event?.message ?? 'unknown error'}`);
      void end(1, 'The database Worker failed.');
    };
    const base = workerLink(worker);
    const mux = createLinkMux(base);
    attach(mux.subLink());
    base.post({ type: 'database-open', dataDir: options.dataDir, relaxedDurability: options.relaxedDurability, pgliteUrl: options.pgliteUrl, idleInTransactionTimeoutMs: options.idleInTransactionTimeoutMs });
    if (persistent && Channel) tabs = serveFollowerTabs(Channel, key, tabId, mux);
  };

  /** Stop for good: no listener, no clients, no Worker, no claim on the database. Resolves once the claim is given up. */
  const end = async (code: number, reason: string): Promise<void> => {
    if (ended) return;
    ended = true;
    registration.close();
    hangUpAuthenticating();
    dropAll(reason);
    booted.reject(new Error(reason));
    tabs?.close(); // followers hear the owner went; the next in line takes over
    link?.close();
    worker?.terminate();
    // The lock is freed asynchronously: wait for it, so a restart in this tab right after close() claims it rather than queueing behind its own predecessor.
    await ownership?.release();
    resolveClosed(code);
  };

  const call = (operation: DatabaseOperation): Promise<unknown> => {
    if (ended) return Promise.reject(new Error('The database is closed.'));
    const callId = nextCall++;
    return new Promise((resolve, reject) => {
      calls.set(callId, { resolve, reject });
      link?.post({ type: 'db-call', callId, operation });
    });
  };

  if (!ownership || ownership.owner) becomeOwner();
  else if (Channel) {
    attach(followerLink(Channel, key, tabId));
    ownership.onOwner(becomeOwner);
  } else {
    // A follower reaches the owner over BroadcastChannel; without it, wait to own the database.
    ownership.onOwner(becomeOwner);
  }

  return {
    port: registration.port,
    get role() {
      return role;
    },
    booted: bootedPromise,
    closed,
    query: (sql) => call({ op: 'query', sql }) as Promise<never>,
    export: () => call({ op: 'export' }) as Promise<Blob>,
    import: async (data) => void (await call({ op: 'import', data })),
    reset: async () => void (await call({ op: 'reset' })),
    async close() {
      if (ended) return;
      registration.close(); // stop taking connections first
      clients.closeAll(true); // and hang up on the open ones, so transactions they hold roll back and free the engine
      hangUpAuthenticating();
      if (role === 'owner') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const flushed = call({ op: 'close' }).then(() => true, () => true);
        const timedOut = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), options.closeTimeoutMs ?? 5000)));
        const inTime = await Promise.race([flushed, timedOut]);
        clearTimeout(timer);
        if (!inTime) return end(137, 'The database did not close in time.');
      }
      await end(0, 'The database is closed.');
    },
    terminate: () => void end(137, 'The database was terminated.'),
  };
}
