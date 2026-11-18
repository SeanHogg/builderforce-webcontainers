/**
 * The runtime's Postgres client for PHP (`Bfwc\Pgsql\…`) on a real php-wasm:
 * placeholder rewriting at its edges, PDO's parameter rules (mixed styles
 * refused, missing parameters thrown), int8 on 32-bit PHP, and — against a
 * scripted server on a virtual port — a FATAL error after authentication
 * surfacing as itself, and COPY refused instead of deadlocking.
 */
import { describe, expect, it } from 'vitest';
import { collect, phpHost, readAll } from './php-helpers.js';

const SLOW = 120_000;

const PLACEHOLDERS = String.raw`<?php
use Bfwc\Pgsql\Statement;
$cases = [
    "SELECT * FROM t WHERE a = ? AND b = ?",
    "SELECT ':no', \"?col\", x::int, :name, :name FROM t -- ? :nope\n WHERE y = :other",
    "SELECT E'it\\'s ? :x', 'plain\\' , ?",
    'SELECT $$ ? :x $$, $tag$ ? $tag$, ?',
    'SELECT a$b, ? FROM t',
    "SELECT /* outer /* inner ? */ still :hidden */ ?",
    "SELECT data ?? 'key', ?",
    "SELECT ? FROM e",
];
$out = [];
foreach ($cases as $sql) {
    $out[] = Statement::placeholders($sql);
}
foreach (["SELECT ?, :named", "SELECT :named, ?"] as $mixed) {
    try {
        Statement::placeholders($mixed);
        $out[] = 'accepted';
    } catch (\PDOException $e) {
        $out[] = $e->getMessage();
    }
}
$pdo = (new ReflectionClass(Bfwc\Pgsql\PDO::class))->newInstanceWithoutConstructor();
foreach ([[[1]], [['a' => 1, 'c' => 2]]] as [$params]) {
    try {
        (new Statement($pdo, 'SELECT :a, :b', \PDO::FETCH_ASSOC, false))->execute($params);
    } catch (\PDOException $e) {
        $out[] = $e->getCode() . ' ' . $e->getMessage();
    }
}
$value = new ReflectionMethod(Statement::class, 'value');
$statement = new Statement($pdo, 'SELECT 1', \PDO::FETCH_ASSOC, false);
$out[] = [PHP_INT_SIZE, $value->invoke($statement, '42', 20), $value->invoke($statement, '9223372036854775807', 20), $value->invoke($statement, '4294967295', 26), $value->invoke($statement, 't', 16)];
echo json_encode($out);
`;

describe('Bfwc\\Pgsql\\Statement', () => {
  it('rewrites placeholders only outside literals, identifiers, comments and dollar quotes, and enforces PDO parameter rules', { timeout: SLOW }, async () => {
    const { processes } = phpHost({ 'p.php': PLACEHOLDERS });
    const proc = processes.run('php', ['p.php']);
    const output = await readAll(proc.combinedOutput);
    expect(await proc.wait(), output).toBe(0);
    const [plain, named, eString, dollar, identifier, nested, escaped, eIdentifier, mixed1, mixed2, tooFew, missing, values] = JSON.parse(output) as unknown[];
    expect(plain).toEqual(['SELECT * FROM t WHERE a = $1 AND b = $2', [0, 1]]);
    expect(named).toEqual(["SELECT ':no', \"?col\", x::int, $1, $1 FROM t -- ? :nope\n WHERE y = $2", ['name', 'other']]);
    expect(eString).toEqual(["SELECT E'it\\'s ? :x', 'plain\\' , $1", [0]]);
    expect(dollar).toEqual(['SELECT $$ ? :x $$, $tag$ ? $tag$, $1', [0]]);
    expect(identifier).toEqual(['SELECT a$b, $1 FROM t', [0]]);
    expect(nested).toEqual(['SELECT /* outer /* inner ? */ still :hidden */ $1', [0]]);
    expect(escaped).toEqual(["SELECT data ? 'key', $1", [0]]);
    expect(eIdentifier).toEqual(['SELECT $1 FROM e', [0]]);
    expect(mixed1).toMatch(/HY093.*mixed named and positional/);
    expect(mixed2).toMatch(/HY093.*mixed named and positional/);
    expect(tooFew).toMatch(/^HY093 .*number of bound variables/);
    expect(missing).toMatch(/^HY093 .*parameter was not defined/);
    const [intSize, small, big, oid, bool] = values as [number, unknown, unknown, unknown, unknown];
    expect(small).toBe(42);
    expect(bool).toBe(true);
    // php-wasm is 32-bit: int8 and oid past PHP_INT_MAX stay strings, as pdo_pgsql leaves them.
    if (intSize === 4) {
      expect(big).toBe('9223372036854775807');
      expect(oid).toBe('4294967295');
    } else {
      expect(big).toBe(9223372036854775807);
    }
    processes.dispose();
  });
});

/** A Postgres-speaking server on a virtual port: trust auth, then a FATAL for any query, or CopyIn for COPY (expecting CopyFail). */
const SCRIPTED_SERVER = String.raw`
const net = require('net');
const frame = (type, body) => { const b = Buffer.alloc(5 + body.length); b.write(type, 0); b.writeInt32BE(body.length + 4, 1); body.copy(b, 5); return b; };
const error = (severity, code, message) => frame('E', Buffer.from('S' + severity + '\0V' + severity + '\0C' + code + '\0M' + message + '\0\0'));
const ready = () => frame('Z', Buffer.from('I'));
net.createServer((socket) => {
  let started = false;
  let buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    if (!started) {
      if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
      buffer = buffer.subarray(buffer.readInt32BE(0));
      started = true;
      const ok = Buffer.alloc(4);
      socket.write(Buffer.concat([frame('R', ok), ready()]));
    }
    while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
      const type = String.fromCharCode(buffer[0]);
      const body = buffer.subarray(5, 1 + buffer.readInt32BE(1));
      buffer = buffer.subarray(1 + buffer.readInt32BE(1));
      if (type === 'Q' && String(body).startsWith('COPY')) socket.write(frame('G', Buffer.from([0, 0, 0])));
      else if (type === 'f') socket.write(Buffer.concat([error('ERROR', '57014', 'COPY from stdin failed: ' + String(body).replace(/\0/g, '')), ready()]));
      else if (type === 'Q' || type === 'P') {
        socket.write(error('FATAL', '57P01', 'terminating connection due to administrator command'));
        socket.end();
      }
    }
  });
}).listen(5433, () => console.log('pg ready'));
`;

const CLIENT = String.raw`<?php
$pdo = new Bfwc\Pgsql\PDO('pgsql:host=localhost;port=5433;dbname=app', 'postgres');
try {
    $pdo->exec("COPY items FROM STDIN");
    echo "copy: accepted\n";
} catch (\PDOException $e) {
    echo 'copy: ', $e->getCode(), ' ', $e->getMessage(), "\n";
}
try {
    $pdo->query('SELECT 1');
    echo "query: accepted\n";
} catch (\PDOException $e) {
    echo 'query: ', $e->getCode(), ' ', $e->getMessage(), "\n";
}
`;

describe('Bfwc\\Pgsql\\Wire against a scripted server', () => {
  it('refuses COPY without deadlocking, and reports a FATAL after authentication as itself', { timeout: SLOW }, async () => {
    const { processes } = phpHost({ 'server.js': SCRIPTED_SERVER, 'client.php': CLIENT });
    const server = processes.run('node', ['server.js']);
    await collect(server.combinedOutput).until('pg ready');
    const client = processes.run('php', ['client.php']);
    const output = await readAll(client.combinedOutput);
    expect(await client.wait(), output).toBe(0);
    expect(output).toMatch(/copy: 0A000 SQLSTATE\[0A000\]: COPY FROM STDIN is not supported/);
    expect(output).toContain('query: 57P01 SQLSTATE[57P01]: FATAL:  terminating connection due to administrator command');
    server.kill();
    processes.dispose();
  });
});
