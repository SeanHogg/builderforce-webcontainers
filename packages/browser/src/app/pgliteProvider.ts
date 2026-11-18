/**
 * The `pglite` runtime provider: a `database` service (engine `postgres`,
 * provider `pglite`) runs as PGlite in its own Worker on the HOST origin,
 * behind a Postgres wire gateway on the service's virtual TCP port, so services
 * reach it with an unmodified driver at `postgres://<user>:<password>@localhost:<port>/<name>`.
 * Only the gateway's bytes cross to the processes (on the preview origin in
 * relay mode); the code a project runs has no path to the database's storage.
 *
 * Every connection authenticates (W10 control 5): each backend that declares
 * `dependsOn` the database gets its own generated login in its `DATABASE_URL`
 * (`databaseCredentials`, which `serviceEnv` asks for); a frontend gets none.
 * The port is owned by the database service's identity, and the gateway admits
 * a connection only from the service its login was issued to, for the one
 * database name the spec owns.
 *
 * A persistent database lives in IndexedDB, keyed by project and service id —
 * outside the project files, so it survives reloads and never lands in a ZIP
 * export; `persistent: false` keeps it in memory. It outlives restarts of the
 * services that use it and closes with the application. One tab owns it; the
 * origin's other tabs proxy to that tab. `query` readiness is `SELECT 1`.
 */
import { readinessOf, type Acceptance, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { ConnectionHandler, SecurityContext } from '@seanhogg/builderforce-webcontainers-core';
import { DatabaseCredentials, databaseAuthenticator, type RandomSource } from '../database/databaseCredentials.js';
import type { WorkerLike } from '../node/processHost.js';
import { startDatabaseHost, type DatabaseHost } from '../database/databaseHost.js';
import type { LockManagerLike } from '../database/databaseLeadership.js';
import type { ChannelFactory } from '../database/databaseTabs.js';
import { signalExitCode } from '@seanhogg/builderforce-webcontainers-core';

/** What the provider needs from a runtime (`startPreviewRuntime()`'s). */
export interface DatabaseServiceHost {
  /** Serve raw TCP on a virtual port, owned by `owner` (the database service's identity) — the port policy lets only its declared dependents reach it. */
  listenTcp(port: number, accept: ConnectionHandler, owner?: SecurityContext): { port: number; close(): void };
  /** A database Worker on the host origin — never the preview origin. */
  createDatabaseWorker(): WorkerLike;
}

export interface PgliteProviderOptions {
  /** Where the database Worker imports PGlite from. Default: the pinned build on jsDelivr. */
  pgliteUrl?: string;
  /** Flush to IndexedDB after replying rather than before (faster; a crash may lose the last writes). Default false. */
  relaxedDurability?: boolean;
  /** Cut off a connection that sits idle inside a transaction this long. Default 30000ms; 0 = never. */
  idleInTransactionTimeoutMs?: number;
  /** How long a stop waits for PGlite to flush before terminating it. Default 5000ms. */
  closeTimeoutMs?: number;
  /** Default `navigator.locks` (required for persistent databases). */
  locks?: LockManagerLike;
  /** Default `globalThis.BroadcastChannel`. */
  BroadcastChannel?: ChannelFactory;
  /** Where generated logins get their randomness. Default `crypto.getRandomValues`. */
  random?: RandomSource;
}

const ENGINES = new Set(['postgres', 'postgresql']);
const READINESS = new Set(['query', 'port']);

export function acceptsPgliteService(service: ServiceSpec): Acceptance {
  const decline = (reason: string): Acceptance => ({ ok: false, reason });
  if (service.type !== 'database' || !service.database) return decline(`The pglite runtime runs database services; "${service.id}" is a ${service.type} service.`);
  if (!ENGINES.has(service.database.engine.toLowerCase())) return decline(`PGlite is Postgres; database "${service.id}" uses ${service.database.engine}.`);
  if (service.database.provider !== 'pglite') return decline(`Database "${service.id}" asks for provider "${service.database.provider}", not pglite.`);
  if (service.port === undefined) return decline(`Database "${service.id}" needs a port for its connections.`);
  const readiness = readinessOf(service).kind;
  if (!READINESS.has(readiness)) return decline(`A database is ready on "query" (or "port"), not "${readiness}".`);
  return { ok: true };
}

/**
 * `idb://bfwc-<n>-<project>-<database>`: one IndexedDB store (and one cross-tab
 * lock) per project database. Both ids are percent-encoded and the project's
 * encoded length `n` is spelled out, so no two (project, database) pairs share
 * a key — `my-app`/`db` and `my`/`app-db` differ, and so do `a b` and `a_20`.
 */
export function pgliteDataDir(projectId: string, databaseId: string): string {
  const project = encodeURIComponent(projectId);
  return `idb://bfwc-${project.length}-${project}-${encodeURIComponent(databaseId)}`;
}

/** A stream of lines and the function that writes to it. */
function lineStream(): { stream: ReadableStream<string>; write(line: string): void; close(): void } {
  let controller!: ReadableStreamDefaultController<string>;
  let open = true;
  const stream = new ReadableStream<string>({ start: (c) => void (controller = c), cancel: () => void (open = false) });
  return {
    stream,
    write: (line) => open && controller.enqueue(`${line}\n`),
    close: () => {
      if (open) controller.close();
      open = false;
    },
  };
}

export function createPgliteProvider(host: DatabaseServiceHost, options: PgliteProviderOptions = {}): RuntimeProvider {
  // This provider's logins: generated here, per runtime, held on the page; never in the VFS.
  const credentials = new DatabaseCredentials(options.random);
  return {
    id: 'pglite',
    accepts: acceptsPgliteService,
    databaseCredentials: (database, client) => (acceptsPgliteService(database).ok ? credentials.issue(database, client) : undefined),
    async start(service, context) {
      const projectId = context.env.BUILDERFORCE_PROJECT_ID ?? 'project';
      const output = lineStream();
      let database: DatabaseHost;
      try {
        database = await startDatabaseHost({
          createWorker: () => host.createDatabaseWorker(),
          listen: (port, accept, owner) => host.listenTcp(port, accept, owner),
          owner: context.security,
          authenticate: databaseAuthenticator(credentials, service),
          onRefused: (reason) => output.write(`Refused a connection (${reason}).`),
          port: service.port!,
          dataDir: service.database!.persistent ? pgliteDataDir(projectId, service.id) : 'memory://',
          relaxedDurability: options.relaxedDurability,
          pgliteUrl: options.pgliteUrl,
          idleInTransactionTimeoutMs: options.idleInTransactionTimeoutMs,
          closeTimeoutMs: options.closeTimeoutMs,
          locks: options.locks,
          BroadcastChannel: options.BroadcastChannel,
          log: (text) => output.write(text),
        });
      } catch (error) {
        output.close();
        throw error;
      }
      if (database.role === 'follower') output.write('The database is open in another tab; connecting through it.');
      let exitCode: number | undefined;
      const exit = database.closed.then((code) => {
        output.close();
        return exitCode ?? code;
      });
      let ready: Promise<void> | undefined;
      return {
        output: output.stream,
        ready: () =>
          (ready ??= Promise.race([
            database.booted.then(async () => {
              if (readinessOf(service).kind === 'query') await database.query('SELECT 1');
            }),
            exit.then((code): never => {
              throw new Error(`The database closed (code ${code}) before it was ready.`);
            }),
          ])),
        wait: () => exit,
        kill(signal = 'SIGTERM') {
          exitCode ??= signalExitCode(signal);
          // SIGKILL cannot wait for anything; SIGTERM flushes, and terminates after closeTimeoutMs.
          if (signal === 'SIGKILL') database.terminate();
          else void database.close();
        },
        url: () => undefined, // previews reach services over HTTP only, never the database port
        database: {
          export: () => database.export(),
          import: (data) => database.import(data),
          reset: () => database.reset(),
        },
      };
    },
  };
}
