/**
 * Unmodified PHP Postgres code on php-wasm (which has no pdo_pgsql or pgsql
 * extension): `new PDO('pgsql:…')` — in the script `php` runs, in a namespaced
 * class it includes after `use PDO;`, under an alias, with named arguments,
 * through a `uri:` DSN and through `PDO::connect` — reaches the runtime's
 * PDO, while `new PDO('sqlite::memory:')` (and a construction in a parameter
 * default, a constant-expression context) stays native; and the `pg_*`
 * functions do CRUD, prepared statements and a rolled-back transaction.
 * Against the PGlite database the application runtime starts. Offline.
 * (php-pdo-rewrite.test.ts covers the rewriter and the file wrapper alone.)
 */
import { describe, expect, it } from 'vitest';
import { createPgliteProvider, startApplicationRuntime, type ApplicationSpec } from '../src/app.js';
import { createPhpProcessKind, createPhpProvider } from '../src/runtimes/php/index.js';
import { appHost, fakeLocks } from './databaseHelpers.js';
import { phpWorkers } from './php-helpers.js';

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
        return new Database(dsn: $dsn, username: $user, password: $password);
    }

    public static function viaConnect(string $dsn, string $user, ?string $password): PDO
    {
        return PDO::connect($dsn, ...[$user, $password]);
    }

    /** A construction in a parameter default must stay as written (a call would not compile there). */
    public static function inMemory(PDO $db = new PDO('sqlite::memory:')): string
    {
        return $db->getAttribute(PDO::ATTR_DRIVER_NAME);
    }
}
`;

const SCRIPT = String.raw`<?php
require __DIR__ . '/Repository.php';

class Note
{
    public string $body;
    public string $seen;
    public function __construct() { $this->seen = isset($this->body) ? 'set before constructor' : 'unset'; }
}

$url = parse_url(getenv('DATABASE_URL'));
$dsn = sprintf('pgsql:host=%s;port=%d;dbname=postgres', $url['host'], $url['port']);
$user = urldecode($url['user'] ?? 'postgres');
$pass = isset($url['pass']) ? urldecode($url['pass']) : null;
$out = [];

// PDO, as written for pdo_pgsql.
$pdo = new PDO($dsn, $user, $pass, [PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
$out['pdo'] = [$pdo instanceof PDO, $pdo->getAttribute(PDO::ATTR_DRIVER_NAME)];
$pdo->exec('CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL UNIQUE, flag boolean, data bytea)');
$pdo->prepare('INSERT INTO notes (body) VALUES (?)')->execute(['from pdo']);
$repo = App\Repository::connect($dsn, $user, $pass);
$out['namespaced'] = [$repo instanceof \PDO, $repo->query('SELECT body FROM notes')->fetchAll()];
$out['aliased'] = App\Repository::aliased($dsn, $user, $pass)->query('SELECT count(*) FROM notes')->fetchColumn();
$out['connect'] = App\Repository::viaConnect($dsn, $user, $pass)->getAttribute(PDO::ATTR_DRIVER_NAME);
file_put_contents(__DIR__ . '/dsn.txt', $dsn . "\n");
$out['uri'] = (new PDO('uri:file://' . __DIR__ . '/dsn.txt', $user, $pass))->getAttribute(PDO::ATTR_DRIVER_NAME);
$out['default'] = App\Repository::inMemory();
$sqlite = new \PDO('sqlite::memory:');
$out['sqlite'] = [get_class($sqlite), $sqlite->query('SELECT 40 + 2')->fetchColumn()];

// The pgsql extension's functions.
$conninfo = sprintf('host=%s port=%d dbname=postgres user=%s', $url['host'], $url['port'], $user) . ($pass === null ? '' : " password='" . addslashes($pass) . "'");
$db = pg_connect($conninfo);
$out['reuse'] = [pg_connect($conninfo) === $db, pg_connect($conninfo, PGSQL_CONNECT_FORCE_NEW) !== $db, pg_dbname($db)];
$created = pg_query_params($db, 'INSERT INTO notes (body, flag, data) VALUES ($1, $2, $3) RETURNING id', ['from pg', true, pg_escape_bytea($db, "\x00\xff")]);
$out['bytea'] = [bin2hex(pg_unescape_bytea(pg_escape_bytea("\x00\xff"))), bin2hex(pg_unescape_bytea('a\\000\\\\b'))];
$id = pg_fetch_result($created, 'id');
$updated = pg_query_params($db, 'UPDATE notes SET body = $1 WHERE id = $2', ['from pg, edited', $id]);
pg_query($db, 'BEGIN');
pg_query_params($db, 'INSERT INTO notes (body) VALUES ($1)', ['in transaction']);
$failed = @pg_query_params($db, 'INSERT INTO notes (body) VALUES ($1)', ['in transaction']);
$out['failed'] = [$failed, pg_transaction_status($db) === PGSQL_TRANSACTION_INERROR, str_contains(pg_last_error($db), 'duplicate key')];
pg_query($db, 'ROLLBACK');
$prepared = pg_prepare($db, 'drop', 'DELETE FROM notes WHERE body = $1');
$badPrepare = @pg_prepare($db, 'broken', 'SELEC 1');
$deleted = pg_execute($db, 'drop', ['from pdo']);
$list = pg_query($db, 'SELECT id, body, flag, encode(data, \'hex\') AS hex FROM notes ORDER BY id');
$object = pg_fetch_object(pg_query($db, 'SELECT body FROM notes'), null, Note::class);
$out['pg'] = [
    pg_affected_rows($updated), pg_affected_rows($deleted), pg_num_rows($list), pg_fetch_all($list), pg_escape_literal($db, "it's"),
    pg_result_status($prepared) === PGSQL_COMMAND_OK, $badPrepare, pg_result_status($list) === PGSQL_TUPLES_OK, pg_result_status($updated, PGSQL_STATUS_STRING),
    pg_field_type($list, 0), pg_field_type($list, 2), pg_result_error($list), pg_last_oid($created), $object->seen, pg_client_encoding($db), pg_set_client_encoding($db, 'UTF8'),
];
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
    try {
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
        connect: 'pgsql',
        uri: 'pgsql',
        default: 'sqlite',
        sqlite: ['PDO', 42],
        reuse: [true, true, 'postgres'],
        bytea: ['00ff', '61005c62'],
        failed: [false, true, true],
        pg: [1, 1, 1, [{ id: '2', body: 'from pg, edited', flag: 't', hex: '00ff' }], "'it''s'", true, false, true, 'UPDATE 1', 'int4', 'bool', '', 0, 'set before constructor', 'UTF8', 0],
      });
    } finally {
      await app.dispose();
      processes.dispose();
    }
  });
});
