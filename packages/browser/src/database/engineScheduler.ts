/**
 * Many client connections, one database session: PGlite has a single Postgres
 * backend, so the gateway's connections take turns on it. A turn is one batch
 * of a connection's messages. The engine stays with a connection until a reply
 * of its carries `ReadyForQuery` with status idle (`I`): inside `BEGIN …
 * COMMIT` (`T`), after a failed statement in a transaction (`E`), and through
 * any unfinished exchange — extended protocol before `Sync`, `COPY` before
 * `CopyDone` — whose replies carry no `ReadyForQuery`, however small (even
 * empty). So no other connection's statement can land inside it. Once idle, the
 * next connection in line gets the engine. Turns run strictly one at a time.
 *
 * A connection that holds the engine and goes quiet is cut off after
 * `idleInTransactionTimeoutMs` (Postgres's `idle_in_transaction_session_timeout`):
 * rolled back, told (`onExpired`), released. A connection that goes away while
 * holding it is cleaned up first: `Sync`, then `ROLLBACK` if still open.
 *
 * Limits (one shared backend): session state — `SET`, named prepared
 * statements, temp tables, `LISTEN` — is visible to every connection. And a
 * client that, inside its own transaction, waits on ANOTHER connection (a
 * `pool.query` while holding a `pool.connect()` client in `BEGIN`) waits for
 * itself: the second connection's turn comes only after the first commits. The
 * idle timeout ends that deadlock by rolling the first back.
 */
import { lastTransactionStatus, queryMessage, syncMessage, type TransactionStatus } from './pgMessages.js';

/** The one database session, as the scheduler drives it. */
export interface Engine {
  /** Run wire-protocol messages; resolves with the backend's reply bytes. */
  exec(messages: Uint8Array): Promise<Uint8Array>;
}

export interface EngineSession {
  /** Run this connection's messages on its turn; resolves with the reply. */
  exec(messages: Uint8Array): Promise<Uint8Array>;
  /** The connection is gone: drop its waiting turns, and roll back what it left open. */
  close(): void;
}

export interface EngineScheduler {
  /** `onExpired`: this connection held the engine idle too long; it was rolled back and must be disconnected. */
  session(onExpired?: () => void): EngineSession;
  /** Run `work` with the engine to itself, between connections' transactions (export, import, reset, health checks). */
  exclusive<T>(work: (engine: Engine) => Promise<T>): Promise<T>;
}

export interface EngineSchedulerOptions {
  /** How long a connection may hold the engine without sending anything. 0 = forever. Default 30000ms. */
  idleInTransactionTimeoutMs?: number;
}

export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

interface Owner {
  /** Called when its hold timed out. */
  expire?(): void;
}

interface Turn {
  owner: Owner;
  /** Whether the owner keeps the engine afterwards. */
  run(engine: Engine): Promise<'hold' | 'release'>;
  fail(error: Error): void;
}

const CLOSED = 'The connection closed.';
/** Not idle: in a transaction, or in an unfinished exchange. */
type SessionStatus = TransactionStatus | 'busy';

export function createEngineScheduler(engine: () => Promise<Engine>, options: EngineSchedulerOptions = {}): EngineScheduler {
  const idleTimeoutMs = options.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS;
  const turns: Turn[] = [];
  let holder: Owner | undefined;
  let running = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  /** The holder has nothing queued: start its idle clock. */
  const armIdle = (owner: Owner) => {
    if (idleTimer !== undefined || idleTimeoutMs <= 0 || !owner.expire) return; // already counting since its last turn
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (holder === owner && !running) owner.expire!();
    }, idleTimeoutMs);
  };

  const pump = () => {
    if (running) return;
    const index = holder ? turns.findIndex((turn) => turn.owner === holder) : 0;
    if (index < 0 || !turns.length) {
      if (holder && index < 0) armIdle(holder);
      return;
    }
    disarm();
    const [turn] = turns.splice(index, 1);
    running = true;
    void engine()
      .then((current) => turn!.run(current))
      .catch((error: unknown) => {
        turn!.fail(error instanceof Error ? error : new Error(String(error)));
        return 'release' as const;
      })
      .then((after) => {
        holder = after === 'hold' ? turn!.owner : undefined;
        running = false;
        pump();
      });
  };

  const enqueue = <T>(owner: Owner, run: (engine: Engine) => Promise<{ value: T; after: 'hold' | 'release' }>) =>
    new Promise<T>((resolve, reject) => {
      turns.push({
        owner,
        async run(current) {
          const { value, after } = await run(current);
          resolve(value);
          return after;
        },
        fail: reject,
      });
      pump();
    });

  return {
    session(onExpired) {
      const owner: Owner = {};
      let status: SessionStatus = 'I';
      let closed = false;
      const settle = (reply: Uint8Array) => {
        status = lastTransactionStatus(reply) ?? 'busy';
        return status === 'I' ? ('release' as const) : ('hold' as const);
      };
      /** Leave the engine as found: finish an open exchange, roll back an open transaction. */
      const cleanUp = async (current: Engine) => {
        if (status !== 'I') settle(await current.exec(syncMessage()));
        if (status !== 'I') settle(await current.exec(queryMessage('ROLLBACK')));
        return { value: undefined, after: 'release' as const };
      };
      const dropTurns = () => {
        for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.owner === owner) turns.splice(i, 1)[0]!.fail(new Error(CLOSED));
      };
      if (onExpired) {
        owner.expire = () => {
          closed = true;
          dropTurns();
          void enqueue(owner, cleanUp).finally(onExpired).catch(() => undefined);
        };
      }
      return {
        exec(messages) {
          if (closed) return Promise.reject(new Error(CLOSED));
          return enqueue(owner, async (current) => {
            const reply = await current.exec(messages);
            return { value: reply, after: settle(reply) };
          });
        },
        close() {
          if (closed) return;
          closed = true;
          dropTurns();
          void enqueue(owner, cleanUp).catch(() => undefined);
        },
      };
    },
    exclusive(work) {
      return enqueue({}, async (current) => ({ value: await work(current), after: 'release' as const }));
    },
  };
}
