/**
 * The Postgres wire gateway end to end: PGlite in a database Worker, the
 * gateway on a virtual TCP port, and UNMODIFIED `pg` and `drizzle-orm` (copied
 * from node_modules into the project, as `npm install` would) running as Node
 * programs in process Workers. The cases that only need a database share one
 * booted in-memory PGlite; each uses its own tables.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDatabaseHost, type DatabaseHost, type DatabaseHostOptions } from '../src/database/databaseHost.js';
import { pgliteDataDir } from '../src/app/pgliteProvider.js';
import { appHost, collect, fakeDatabaseWorker, fakeLocks, installedPackage, trustConnections } from './databaseHelpers.js';

type Runtime = ReturnType<typeof appHost>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PACKAGES = { ...installedPackage('pg'), ...installedPackage('drizzle-orm', { include: /\.(cjs|json)$/ }) };

function startDatabase(runtime: Runtime, port: number, extra: Partial<DatabaseHostOptions> = {}): Promise<DatabaseHost> {
  return startDatabaseHost({ createWorker: fakeDatabaseWorker, listen: runtime.databases.listenTcp, port, dataDir: 'memory://', authenticate: trustConnections, ...extra });
}

/** Run `script` as main.js with DATABASE_URL pointing at `port`. */
async function node(runtime: Runtime, script: string, port = 5432): Promise<{ output: string; code: number }> {
  runtime.fs.writeFile('/main.js', script);
  const proc = runtime.processes.run('node', ['main.js'], { env: { DATABASE_URL: `postgres://postgres@localhost:${port}/postgres` } });
  const output = await collect(proc.combinedOutput).done;
  return { output, code: await proc.wait() };
}

/** A raw protocol client on the page: bytes in, message types out. */
function rawClient(runtime: Runtime, port = 5432) {
  const socket = runtime.processes.ports.connect(port)!;
  let bytes: number[] = [];
  const checks = new Set<() => void>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  socket.onData((data) => {
    bytes.push(...data);
    checks.forEach((check) => check());
  });
  socket.onClose(resolveClosed);
  /** The backend message types received so far (`R`, `S`, …, `Z`). */
  const types = () => {
    let out = '';
    for (let at = 0; at + 5 <= bytes.length; at += 1 + new DataView(Uint8Array.from(bytes).buffer).getInt32(at + 1)) out += String.fromCharCode(bytes[at]!);
    return out;
  };
  return {
    send: (data: Uint8Array | number[]) => socket.send(Uint8Array.from(data)),
    types,
    text: () => decoder.decode(Uint8Array.from(bytes)),
    reset: () => void (bytes = []),
    until: (done: () => boolean) =>
      new Promise<void>((resolve) => {
        const check = () => done() && (checks.delete(check), resolve());
        checks.add(check);
        check();
      }),
    closed,
    close: () => socket.close(),
  };
}

const int32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const startupMessage = () => {
  const body = [...int32(196608), ...encoder.encode('user\0postgres\0database\0postgres\0\0')];
  return [...int32(body.length + 4), ...body];
};
const queryBytes = (sql: string) => {
  const body = [...encoder.encode(`${sql}\0`)];
  return [0x51, ...int32(body.length + 4), ...body];
};

describe('Postgres wire gateway (shared in-memory database)', () => {
  let runtime: Runtime;
  let db: DatabaseHost;
  beforeAll(async () => {
    runtime = appHost(PACKAGES);
    db = await startDatabase(runtime, 5432);
    await db.booted;
  }, 60_000);
  afterAll(() => db.close());

  it('answers SSLRequest with N, then frames a start-up and a query that arrive split across chunks', async () => {
    const client = rawClient(runtime);
    client.send([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]); // SSLRequest
    await client.until(() => client.text() === 'N');
    client.reset();
    for (const byte of startupMessage()) client.send([byte]); // one byte per chunk
    await client.until(() => client.types().endsWith('Z'));
    expect(client.types()).toMatch(/^RS+KZ$/);
    client.reset();
    const query = queryBytes('SELECT 41 + 1 AS answer');
    client.send(query.slice(0, 3));
    client.send(query.slice(3));
    await client.until(() => client.types() === 'TDCZ');
    expect(client.text()).toContain('42');
    client.close();
  });

  it('ends a connection that breaks the protocol with FATAL 08P01: a bad length, an oversized start-up, HTTP', async () => {
    const badLength = rawClient(runtime);
    badLength.send(startupMessage());
    await badLength.until(() => badLength.types().endsWith('Z'));
    badLength.reset();
    badLength.send([0x51, 0, 0, 0, 2]);
    await badLength.closed;
    expect(badLength.types()).toBe('E');
    expect(badLength.text()).toContain('08P01');

    const oversized = rawClient(runtime);
    oversized.send([...int32(100_000), ...int32(196608)]);
    await oversized.closed;
    expect(oversized.text()).toMatch(/FATAL.*08P01.*exceeds the limit/s);

    const http = rawClient(runtime);
    http.send(encoder.encode('GET / HTTP/1.1\r\nHost: localhost:5432\r\n\r\n'));
    await http.closed;
    expect(http.types()).toBe('E');
    expect(http.text()).toContain('08P01');
  });

  it('runs simple, parameterized (extended) and transactional queries through an unmodified pg Client', async () => {
    const { output, code } = await node(
      runtime,
      `
      const { Client } = require('pg');
      (async () => {
        const client = new Client({ connectionString: process.env.DATABASE_URL });
        await client.connect();
        console.log('version', (await client.query('SHOW server_version')).rows[0].server_version.split('.')[0] > 10);
        await client.query('CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL, qty int)');
        const inserted = await client.query('INSERT INTO items (name, qty) VALUES ($1, $2), ($3, $4) RETURNING id', ['a', 1, 'b', 2]);
        console.log('inserted', inserted.rowCount, inserted.rows.map((r) => r.id).join(','));
        const found = await client.query({ text: 'SELECT name, qty FROM items WHERE qty > $1 ORDER BY id', values: [0] });
        console.log('rows', JSON.stringify(found.rows));
        await client.query('BEGIN');
        await client.query('UPDATE items SET qty = qty + $1', [100]);
        console.log('inside', (await client.query('SELECT sum(qty)::int AS s FROM items')).rows[0].s);
        await client.query('ROLLBACK');
        console.log('after rollback', (await client.query('SELECT sum(qty)::int AS s FROM items')).rows[0].s);
        try { await client.query('SELECT * FROM missing_table'); } catch (e) { console.log('error', e.code); }
        console.log('still usable', (await client.query('SELECT 1 AS one')).rows[0].one);
        await client.end();
        console.log('ended');
      })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
      `,
    );
    expect(output).toBe('version true\ninserted 2 1,2\nrows [{"name":"a","qty":1},{"name":"b","qty":2}]\ninside 203\nafter rollback 3\nerror 42P01\nstill usable 1\nended\n');
    expect(code).toBe(0);
  });

  it("keeps one connection's transaction to itself: a second client waits until it commits", async () => {
    const { output } = await node(
      runtime,
      `
      const { Client, Pool } = require('pg');
      (async () => {
        const a = new Client(process.env.DATABASE_URL), b = new Client(process.env.DATABASE_URL);
        await a.connect(); await b.connect();
        await a.query('CREATE TABLE conc (n int)');
        await a.query('BEGIN');
        await a.query('INSERT INTO conc VALUES (1)');
        const events = [];
        const read = b.query('SELECT count(*)::int AS c FROM conc').then((r) => events.push('b saw ' + r.rows[0].c));
        await new Promise((r) => setTimeout(r, 50));
        events.push('a commits');
        await a.query('INSERT INTO conc VALUES (2)');
        await a.query('COMMIT');
        await read;
        console.log(events.join('; '));
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
        const counts = await Promise.all([1, 2, 3].map(() => pool.query('SELECT count(*)::int AS c FROM conc')));
        console.log('pool', counts.map((r) => r.rows[0].c).join(','));
        await pool.end(); await a.end(); await b.end();
      })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
      `,
    );
    expect(output).toBe('a commits; b saw 2\npool 2,2,2\n');
  });

  it('never interleaves extended-protocol exchanges: 40 concurrent parameterized pool queries each get their own row', async () => {
    const { output } = await node(
      runtime,
      `
      const { Pool } = require('pg');
      (async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
        const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
          pool.query('SELECT $1::int AS n, $2::text AS s, pg_sleep(0) AS z', [i, 'row-' + i]).then((r) => r.rows[0])));
        const wrong = results.filter((row, i) => row.n !== i || row.s !== 'row-' + i);
        console.log('rows', results.length, 'wrong', wrong.length);
        await pool.end();
      })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
      `,
    );
    expect(output).toBe('rows 40 wrong 0\n');
  });

  it('rolls back a transaction left open by a client that disconnects', async () => {
    await db.query('CREATE TABLE left_open (n int)');
    const { output } = await node(
      runtime,
      `
      const { Client } = require('pg');
      (async () => {
        const c = new Client(process.env.DATABASE_URL);
        c.on('error', () => console.log('disconnected'));
        await c.connect();
        await c.query('BEGIN');
        await c.query('INSERT INTO left_open VALUES (1)');
        c.connection.stream.destroy();
      })();
      `,
    );
    expect(output).toBe('disconnected\n');
    expect(await db.query('SELECT count(*)::int AS c FROM left_open')).toEqual([{ c: 0 }]);
  });

  it('serves Drizzle (drizzle-orm/node-postgres) CRUD', async () => {
    const { output, code } = await node(
      runtime,
      `
      const { Pool } = require('pg');
      const { drizzle } = require('drizzle-orm/node-postgres');
      const { pgTable, serial, text } = require('drizzle-orm/pg-core');
      const { eq } = require('drizzle-orm');
      const notes = pgTable('drizzle_notes', { id: serial('id').primaryKey(), body: text('body').notNull() });
      (async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        const db = drizzle(pool);
        await pool.query('CREATE TABLE drizzle_notes (id serial PRIMARY KEY, body text NOT NULL)');
        const [created] = await db.insert(notes).values({ body: 'first' }).returning();
        await db.insert(notes).values([{ body: 'second' }, { body: 'third' }]);
        await db.update(notes).set({ body: 'FIRST' }).where(eq(notes.id, created.id));
        await db.delete(notes).where(eq(notes.body, 'second'));
        await db.transaction(async (tx) => {
          await tx.insert(notes).values({ body: 'rolled back' });
          tx.rollback();
        }).catch(() => console.log('transaction rolled back'));
        console.log(JSON.stringify(await db.select().from(notes).orderBy(notes.id)));
        await pool.end();
      })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
      `,
    );
    expect(output).toBe('transaction rolled back\n[{"id":1,"body":"FIRST"},{"id":3,"body":"third"}]\n');
    expect(code).toBe(0);
  });

  it('refuses a corrupt import and keeps the data', async () => {
    await db.query('CREATE TABLE survivor (n int)');
    await db.query('INSERT INTO survivor VALUES (7)');
    await expect(db.import(new Blob(['this is not a data directory']))).rejects.toThrow(/Not a usable database snapshot/);
    expect(await db.query('SELECT n FROM survivor')).toEqual([{ n: 7 }]);
  });
});

describe('Postgres wire gateway (lifecycles)', () => {
  it('cuts off a connection idle in a transaction (25P03), freeing the engine for the others', async () => {
    const runtime = appHost(PACKAGES);
    const db = await startDatabase(runtime, 5440, { idleInTransactionTimeoutMs: 300 });
    try {
      await db.booted;
      const { output } = await node(
        runtime,
        `
        const { Client } = require('pg');
        (async () => {
          const a = new Client(process.env.DATABASE_URL), b = new Client(process.env.DATABASE_URL);
          let lost = false; // pg reports the FATAL, then the hang-up that follows it
          a.on('error', (e) => lost || (lost = true, console.log('a lost:', e.code || e.message)));
          await a.connect(); await b.connect();
          await a.query('BEGIN');
          await a.query('CREATE TABLE idle_t (n int)');
          // a waits on b inside its own transaction: b's turn can only come once a's ends.
          console.log('b got', (await b.query('SELECT 1 AS one')).rows[0].one);
          console.log('table kept', (await b.query("SELECT count(*)::int AS c FROM pg_tables WHERE tablename = 'idle_t'")).rows[0].c);
          await b.end();
        })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
        `,
        5440,
      );
      expect(output).toBe('a lost: 25P03\nb got 1\ntable kept 0\n');
    } finally {
      await db.close();
    }
  }, 60_000);

  it('closes with a transaction open, and terminates at once', async () => {
    const runtime = appHost(PACKAGES);
    const db = await startDatabase(runtime, 5441);
    await db.booted;
    runtime.fs.writeFile('/hold.js', `
      const { Client } = require('pg');
      const c = new Client('postgres://postgres@localhost:5441/postgres');
      c.on('error', () => console.log('closed under me'));
      c.connect().then(() => c.query('BEGIN')).then(() => console.log('holding'));
    `);
    const holder = runtime.processes.run('node', ['hold.js']);
    const output = collect(holder.combinedOutput);
    await output.until('holding');
    await db.close();
    expect(await db.closed).toBe(0);
    expect(await output.done).toBe('holding\nclosed under me\n');

    const again = await startDatabase(runtime, 5441);
    await again.booted;
    again.terminate();
    expect(await again.closed).toBe(137);
    expect(runtime.processes.ports.has(5441)).toBe(false);
  }, 60_000);

  it('persists in IndexedDB across a restart, and exports, imports and resets', async () => {
    const runtime = appHost();
    const locks = fakeLocks();
    const dataDir = pgliteDataDir(`my app ${Date.now()}`, 'db');
    let db = await startDatabase(runtime, 5442, { dataDir, locks });
    await db.query('CREATE TABLE notes (body text)');
    await db.query("INSERT INTO notes VALUES ('kept')");
    const snapshot = await db.export();
    await db.query("INSERT INTO notes VALUES ('later')");
    await db.close();

    db = await startDatabase(runtime, 5442, { dataDir, locks });
    expect(await db.query('SELECT body FROM notes ORDER BY body')).toEqual([{ body: 'kept' }, { body: 'later' }]);
    await db.import(snapshot);
    expect(await db.query('SELECT body FROM notes')).toEqual([{ body: 'kept' }]);
    await db.reset();
    expect(await db.query("SELECT count(*)::int AS c FROM pg_tables WHERE tablename = 'notes'")).toEqual([{ c: 0 }]);
    await db.close();

    db = await startDatabase(runtime, 5442, { dataDir, locks });
    expect(await db.query("SELECT count(*)::int AS c FROM pg_tables WHERE tablename = 'notes'")).toEqual([{ c: 0 }]);
    await db.close();
  }, 180_000);
});
