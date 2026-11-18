/**
 * Unmodified PHP Postgres code on php-wasm (which has no pdo_pgsql or pgsql
 * extension): `new PDO('pgsql:…')` — in the script `php` runs, in a namespaced
 * class it includes after `use PDO;`, and under an alias — reaches the
 * runtime's PDO, while `new PDO('sqlite::memory:')` stays native; and the
 * `pg_*` functions do CRUD and a rolled-back transaction. Against the PGlite
 * database the application runtime starts. Offline.
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec } from '../src/app.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { phpHost, phpWorkers, readAll } from './php-helpers.js';

const REPOSITORY = String.raw`<?php
namespace App;

use PDO;
use PDO as Database;

final class Repository
{
    public static function connect(string $dsn, string $user, ?string $password): PDO
    {
        return new PDO($dsn, $user, $password, [PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    }

    public static function aliased(string $dsn, string $user, ?string $password): Database
    {
        return new Database($dsn, $user, $password);
    }
}
`;

const SCRIPT = String.raw`<?php
require __DIR__ . '/Repository.php';

$url = parse_url(getenv('DATABASE_URL'));
$dsn = sprintf('pgsql:host=%s;port=%d;dbname=postgres', $url['host'], $url['port']);
$user = urldecode($url['user'] ?? 'postgres');
$pass = isset($url['pass']) ? urldecode($url['pass']) : null;
$out = [];

// PDO, as written for pdo_pgsql.
$pdo = new PDO($dsn, $user, $pass, [PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$out['pdo'] = [$pdo instanceof PDO, $pdo->getAttribute(PDO::ATTR_DRIVER_NAME)];
$pdo->exec('CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL UNIQUE)');
$pdo->prepare('INSERT INTO notes (body) VALUES (?)')->execute(['from pdo']);
$repo = App\Repository::connect($dsn, $user, $pass);
$out['namespaced'] = [$repo instanceof \PDO, $repo->query('SELECT body FROM notes')->fetchAll()];
$out['aliased'] = App\Repository::aliased($dsn, $user, $pass)->query('SELECT count(*) FROM notes')->fetchColumn();
$sqlite = new \PDO('sqlite::memory:');
$out['sqlite'] = [get_class($sqlite), $sqlite->query('SELECT 40 + 2')->fetchColumn()];

// The pgsql extension's functions.
$db = pg_connect(sprintf('host=%s port=%d dbname=postgres user=%s', $url['host'], $url['port'], $user) . ($pass === null ? '' : " password='" . addslashes($pass) . "'"));
$created = pg_query_params($db, 'INSERT INTO notes (body) VALUES ($1) RETURNING id', ['from pg']);
$id = pg_fetch_result($created, 0, 'id');
$updated = pg_query_params($db, 'UPDATE notes SET body = $1 WHERE id = $2', ['from pg, edited', $id]);
pg_query($db, 'BEGIN');
pg_query_params($db, 'INSERT INTO notes (body) VALUES ($1)', ['in transaction']);
$failed = @pg_query_params($db, 'INSERT INTO notes (body) VALUES ($1)', ['in transaction']);
$out['failed'] = [$failed, pg_transaction_status($db) === PGSQL_TRANSACTION_INERROR, str_contains(pg_last_error($db), 'duplicate key')];
pg_query($db, 'ROLLBACK');
pg_prepare($db, 'drop', 'DELETE FROM notes WHERE body = $1');
$deleted = pg_execute($db, 'drop', ['from pdo']);
$list = pg_query($db, 'SELECT id, body FROM notes ORDER BY id');
$out['pg'] = [pg_affected_rows($updated), pg_affected_rows($deleted), pg_num_rows($list), pg_fetch_all($list), pg_escape_literal($db, "it's")];
file_put_contents('result.json', json_encode($out));
`;

describe('built-in PDO pgsql and pg_* (offline)', () => {
  it('runs unmodified new PDO("pgsql:…") and pg_* code against the shared database, keeping other PDO drivers native', { timeout: 300_000 }, async () => {
    const { fs, processes, databases } = appHost({ 'job/Repository.php': REPOSITORY, 'job/crud.php': SCRIPT }, phpWorkers(), createPhpProcessKind());
    const spec: ApplicationSpec = {
      projectId: `php-builtin-${Date.now()}`,
      services: [
        { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
        { id: 'job', type: 'application', runtime: 'php', root: '/job', command: 'php', args: ['crud.php'], dependsOn: ['db'], readiness: { kind: 'exit-zero' }, restartPolicy: 'never' },
      ],
    };
    const runtime = { run: processes.run.bind(processes), onServerListening: (l: never) => processes.servers.onListening(l), onPortChange: (l: never) => processes.servers.onPortChange(l), listProcesses: () => processes.list() };
    const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPhpProvider(runtime, { probeIntervalMs: 50 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 120_000 });
    const logs: string[] = [];
    void (async () => {
      for await (const entry of app.logs('job')) logs.push(entry.text);
    })();
    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    }
    expect(JSON.parse(fs.readText('/job/result.json') ?? 'null'), logs.join('')).toEqual({
      pdo: [true, 'pgsql'],
      namespaced: [true, [{ body: 'from pdo' }]],
      aliased: 1,
      sqlite: ['PDO', 42],
      failed: [false, true, true],
      pg: [1, 1, 1, [{ id: '2', body: 'from pg, edited' }], "'it''s'"],
    });
    await app.dispose();
    processes.dispose();
  });

  it('rewrites only constructions of the global PDO, keeping line numbers', { timeout: 120_000 }, async () => {
    const cases = [
      '<?php $a = new PDO($d);',
      '<?php $a = new \\PDO ( $d );',
      '<?php namespace App; $a = new PDO($d);',
      '<?php namespace App; use PDO; $a = new PDO($d); $f = function () use ($d) { return new PDO($d); };',
      '<?php $a = new PDO\n($d); echo __LINE__;',
      '<?php echo "new PDO("; // new PDO(',
      '<?php $a = new PDOStatement(); $b = PDO::ATTR_ERRMODE; class X extends PDO {}',
    ];
    const script = `<?php\n$cases = json_decode(<<<'JSON'\n${JSON.stringify(cases)}\nJSON, true);\necho json_encode(array_map([Bfwc\\Pgsql\\Includes::class, 'rewrite'], $cases));\n`;
    const { processes } = phpHost({ 'r.php': script });
    const proc = processes.run('php', ['r.php']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait(), output).toBe(0);
    expect(JSON.parse(output)).toEqual([
      '<?php $a = \\Bfwc\\Pgsql\\pdo($d);',
      '<?php $a = \\Bfwc\\Pgsql\\pdo( $d );',
      '<?php namespace App; $a = new PDO($d);',
      '<?php namespace App; use PDO; $a = \\Bfwc\\Pgsql\\pdo($d); $f = function () use ($d) { return \\Bfwc\\Pgsql\\pdo($d); };',
      '<?php $a = \\Bfwc\\Pgsql\\pdo\n($d); echo __LINE__;',
      '<?php echo "new PDO("; // new PDO(',
      '<?php $a = new PDOStatement(); $b = PDO::ATTR_ERRMODE; class X extends PDO {}',
    ]);
    processes.dispose();
  });
});
