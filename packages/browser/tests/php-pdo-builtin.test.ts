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

// Recovery after a failed pg_execute; extension-shaped rows, fields, errors.
pg_prepare($db, 'asInt', 'SELECT $1::int AS n');
$bad = @pg_execute($db, 'asInt', ['not a number']);
$good = pg_execute($db, 'asInt', ['5']);
$both = pg_query($db, "SELECT 1 AS a, NULL::text AS b, 'xyz'::varchar(10) AS c");
$errors = [];
foreach ([fn () => pg_field_name($both, 9), fn () => pg_fetch_result($both, 0, 'nope')] as $call) {
    try { $call(); } catch (ValueError $e) { $errors[] = $e->getMessage(); }
}
$table = pg_query($db, 'SELECT body FROM notes');
$other = pg_connect($conninfo, PGSQL_CONNECT_FORCE_NEW);
pg_close($other);
try { pg_query($other, 'SELECT 1'); } catch (Error $e) { $errors[] = $e->getMessage(); }
$out['more'] = [
    $bad, pg_fetch_result($good, 0, 0), pg_transaction_status($db) === PGSQL_TRANSACTION_IDLE,
    pg_fetch_all($both) === pg_fetch_all($both), pg_fetch_assoc($both)['a'], array_keys(pg_fetch_array($both, 0)),
    pg_field_is_null($both, 0, 'b'), pg_field_prtlen($both, 0, 'c'), pg_field_size($both, 0), pg_field_table($table, 0), pg_field_table($both, 0),
    $errors, pg_host($db) !== '', pg_port($db), pg_get_pid($db) > 0, pg_connection_reset($db), pg_connection_status($db) === PGSQL_CONNECTION_OK,
    str_contains(var_export($db, true) . print_r($db, true), (string) $pass) && $pass !== '',
];
// Connection objects refuse construction, cloning and serialization; class names autoload case-insensitively.
$refusals = [];
foreach ([fn () => new PgSql\Connection(), fn () => clone $db, fn () => serialize($db)] as $call) {
    try { $call(); } catch (Throwable $e) { $refusals[] = get_class($e) . ': ' . $e->getMessage(); }
}
$out['refusals'] = [$refusals, class_exists('BFWC\PGSQL\REWRITER')];

// A connection whose server connection breaks goes BAD (no throw), and pg_ping reconnects it. PGlite's gateway
// cannot pg_terminate_backend, so the client's socket is swapped for a dead (read-only, empty) stream instead.
$victim = pg_connect($conninfo, PGSQL_CONNECT_FORCE_NEW);
$wire = (new ReflectionProperty(Bfwc\Pgsql\Pg::class, 'state'))->getValue()[$victim]->wire;
(new ReflectionProperty(Bfwc\Pgsql\Wire::class, 'socket'))->setValue($wire, fopen('php://memory', 'r'));
$killed = true;
$first = @pg_query($victim, 'SELECT 1');
$bad = pg_connection_status($victim) === PGSQL_CONNECTION_BAD;
$second = @pg_query($victim, 'SELECT 1');
$out['bad'] = [$killed, $first, $bad, $second, pg_last_error($victim), pg_ping($victim), pg_connection_status($victim) === PGSQL_CONNECTION_OK, pg_fetch_result(pg_query($victim, 'SELECT 7'), 0, 0), pg_close($victim)];
try { pg_connection_status($victim); } catch (Error $e) { $out['bad'][] = $e->getMessage(); }
file_put_contents('result.json', json_encode($out));
`;

/** PHP 8.4: Pdo\Pgsql, as constructed and as PDO::connect / Pdo\Pgsql::connect return it, against the database. */
const PHP84 = String.raw`<?php
$url = parse_url(getenv('DATABASE_URL'));
$dsn = sprintf('pgsql:host=%s;port=%d;dbname=postgres', $url['host'], $url['port']);
$user = urldecode($url['user'] ?? 'postgres');
$pass = isset($url['pass']) ? urldecode($url['pass']) : null;
$direct = new Pdo\Pgsql($dsn, $user, $pass);
$lower = new PDO\PGSQL($dsn, $user, $pass);
$viaPdo = PDO::connect($dsn, $user, $pass);
$viaPgsql = Pdo\Pgsql::connect($dsn, $user, $pass);
file_put_contents('result.json', json_encode([
    PHP_VERSION_ID >= 80400,
    [$direct instanceof Pdo\Pgsql, $direct instanceof PDO, $lower instanceof Pdo\Pgsql, $viaPdo instanceof Pdo\Pgsql, $viaPgsql instanceof Pdo\Pgsql],
    $direct->query('SELECT 40 + 2')->fetchColumn(), $direct->escapeIdentifier('a"b'), $direct->getPid() > 0,
]));
`;

/** Run `php <script>` as a job next to a PGlite database; its result.json (and the job's log on failure). */
async function runJob(files: Record<string, string>, script: string, phpVersion?: string): Promise<{ result: unknown; log: string }> {
  const { fs, processes, databases } = appHost(Object.fromEntries(Object.entries(files).map(([path, content]) => [`job/${path}`, content])), phpWorkers(), createPhpProcessKind(phpVersion ? { phpVersion } : undefined));
  const spec: ApplicationSpec = {
    projectId: `php-builtin-${Date.now()}`,
    services: [
      { id: 'db', type: 'database', runtime: 'pglite', port: 5432, readiness: { kind: 'query' }, database: { engine: 'postgres', provider: 'pglite', persistent: false } },
      { id: 'job', type: 'application', runtime: 'php', root: '/job', command: 'php', args: [script], dependsOn: ['db'], readiness: { kind: 'exit-zero' }, restartPolicy: 'never' },
    ],
  };
  const runtime = { run: processes.run.bind(processes), onServerListening: (l: never) => processes.servers.onListening(l), onPortChange: (l: never) => processes.servers.onPortChange(l), listProcesses: () => processes.list() };
  const app = startApplicationRuntime(spec, { runtime: processes, providers: [createPhpProvider(runtime, { probeIntervalMs: 50 }), createPgliteProvider(databases, { locks: fakeLocks() })], readinessTimeoutMs: 120_000 });
  const logs: string[] = [];
  try {
    void (async () => {
      for await (const entry of app.logs('job')) logs.push(entry.text);
    })();
    try {
      await app.start();
    } catch (error) {
      throw new Error(`${(error as Error).message}\n${logs.join('')}`);
    }
    return { result: JSON.parse(fs.readText('/job/result.json') ?? 'null'), log: logs.join('') };
  } finally {
    await app.dispose();
    processes.dispose();
  }
}

describe('built-in PDO pgsql and pg_* (offline)', () => {
  it('runs unmodified new PDO("pgsql:…") and pg_* code against the shared database, keeping other PDO drivers native', { timeout: 300_000 }, async () => {
    const { result, log } = await runJob({ 'Repository.php': REPOSITORY, 'crud.php': SCRIPT }, 'crud.php');
    expect(result, log).toEqual({
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
      pg: [1, 1, 1, [{ id: '2', body: 'from pg, edited', flag: 't', hex: '00ff' }], "'it''s'", true, false, true, 'UPDATE 1', 'int4', 'bool', '', false, 'set before constructor', 'UTF8', 0],
      more: [
        false, '5', true,
        true, '1', [0, 'a', 1, 'b', 2, 'c'],
        1, 3, 4, 'notes', false,
        [
          'pg_field_name(): Argument #2 ($field) must be less than the number of fields for this result set',
          'pg_fetch_result(): Argument #3 ($field) must be a field name from this result set',
          'PostgreSQL connection has already been closed',
        ],
        true, expect.any(String), true, true, true,
        false,
      ],
      refusals: [
        [
          'Error: Cannot directly construct PgSql\\Connection, use pg_connect() instead',
          'Error: Trying to clone an uncloneable object of class PgSql\\Connection',
          "Exception: Serialization of 'PgSql\\Connection' is not allowed",
        ],
        true,
      ],
      bad: [true, false, true, false, 'no connection to the server', true, true, '7', true, 'PostgreSQL connection has already been closed'],
    });
  });

  it('PHP 8.4: new Pdo\\Pgsql, PDO::connect and Pdo\\Pgsql::connect reach the runtime driver as Pdo\\Pgsql', { timeout: 300_000 }, async () => {
    const { result, log } = await runJob({ 'main.php': PHP84 }, 'main.php', '8.4');
    expect(result, log).toEqual([true, [true, true, true, true, true], 42, '"a""b"', true]);
  });
});
