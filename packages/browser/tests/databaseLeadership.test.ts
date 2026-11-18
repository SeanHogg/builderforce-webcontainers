/**
 * Who runs a database: one owner tab per persistent database (Web Locks; the
 * next tab in line takes over), followers proxied to it over BroadcastChannel,
 * database Workers always on the host origin, and storage keys that never
 * collide.
 */
import { describe, expect, it } from 'vitest';
import { claimDatabase, DatabaseCoordinationError } from '../src/database/databaseLeadership.js';
import { startDatabaseHost } from '../src/database/databaseHost.js';
import { pgliteDataDir } from '../src/app/pgliteProvider.js';
import { databaseWorkerFactory, trackWorkers } from '../src/node/index.js';
import type { WorkerLike } from '../src/node/processHost.js';
import { appHost, collect, fakeDatabaseWorker, fakeLocks, installedPackage } from './databaseHelpers.js';

const stubWorker = (): WorkerLike => ({ onmessage: null, postMessage: () => undefined, terminate: () => undefined });

describe('database ownership', () => {
  it('gives a free database to the first tab, queues the next, and hands over on release', async () => {
    const locks = fakeLocks();
    const first = await claimDatabase(locks, 'k');
    const second = await claimDatabase(locks, 'k');
    expect([first.owner, second.owner]).toEqual([true, false]);
    const handedOver = new Promise<void>((resolve) => second.onOwner(resolve));
    first.release();
    await handedOver;
    expect(second.owner).toBe(true);
    second.release();
  });

  it('refuses a persistent database without Web Locks rather than risk two owners', async () => {
    await expect(claimDatabase(undefined, 'k')).rejects.toBeInstanceOf(DatabaseCoordinationError);
    await expect(claimDatabase(undefined, 'k')).rejects.toThrow(/need the Web Locks API/);
  });

  it('keys storage and locks unambiguously by project and database id', () => {
    const keys = [pgliteDataDir('my-app', 'db'), pgliteDataDir('my', 'app-db'), pgliteDataDir('a b', 'db'), pgliteDataDir('a_20', 'db'), pgliteDataDir('a%20', 'db')];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('starts database Workers through the host-side factory, never the relay (preview-origin) one, and stops them on dispose', () => {
    const created: string[] = [];
    const relay = () => (created.push('relay'), stubWorker());
    const hostSide = () => (created.push('host'), stubWorker());
    const workers = trackWorkers(databaseWorkerFactory({ createWorker: relay, createDatabaseWorker: hostSide }));
    const worker = workers.create();
    expect(created).toEqual(['host']);
    let terminated = 0;
    const original = worker.terminate;
    worker.terminate = () => (terminated++, original());
    workers.terminateAll();
    workers.terminateAll();
    expect(terminated).toBe(1);
  });
});

describe('database shared by tabs', () => {
  it('serves a follower tab through the owner, and the follower takes over (from IndexedDB) when the owner closes', async () => {
    const locks = fakeLocks();
    const dataDir = pgliteDataDir(`tabs-${Date.now()}`, 'db');
    const tabA = appHost();
    const tabB = appHost(installedPackage('pg'));
    const options = { createWorker: fakeDatabaseWorker, port: 5451, dataDir, locks, BroadcastChannel };
    const owner = await startDatabaseHost({ ...options, listen: tabA.databases.listenTcp });
    await owner.booted;
    let tookOver!: () => void;
    const reopened = new Promise<void>((resolve) => (tookOver = resolve));
    const follower = await startDatabaseHost({ ...options, listen: tabB.databases.listenTcp, log: (text) => text.startsWith('PGlite ready') && tookOver() });
    expect([owner.role, follower.role]).toEqual(['owner', 'follower']);
    await follower.booted;

    tabB.fs.writeFile('/main.js', `
      const { Client } = require('pg');
      const url = 'postgres://postgres@localhost:5451/postgres';
      (async () => {
        const first = new Client(url);
        first.on('error', () => console.log('lost the owner tab'));
        await first.connect();
        await first.query('CREATE TABLE shared (tab text)');
        await first.query("INSERT INTO shared VALUES ('b')");
        console.log('written through the owner');
        await new Promise((resolve) => first.on('end', resolve));
        for (let attempt = 0; ; attempt++) {
          const again = new Client(url);
          again.on('error', () => undefined);
          try {
            await again.connect();
            console.log('rows after takeover', (await again.query('SELECT count(*)::int AS c FROM shared')).rows[0].c);
            await again.end();
            return;
          } catch (error) {
            if (attempt > 50) throw error;
            await new Promise((r) => setTimeout(r, 20));
          }
        }
      })().catch((e) => { console.error('FAILED', e && e.stack); process.exitCode = 1; });
    `);
    const program = tabB.processes.run('node', ['main.js']);
    const output = collect(program.combinedOutput);
    await output.until('written through the owner');
    expect(await owner.query('SELECT tab FROM shared')).toEqual([{ tab: 'b' }]);

    await owner.close();
    await reopened;
    expect(follower.role).toBe('owner');
    expect(await output.done).toBe('written through the owner\nlost the owner tab\nrows after takeover 1\n');
    await follower.close();
  }, 120_000);
});
