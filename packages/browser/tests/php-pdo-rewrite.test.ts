/**
 * The machinery behind built-in `new PDO('pgsql:…')` on a real php-wasm:
 * `Bfwc\Pgsql\Rewriter` (which constructions it rewrites, and which it must
 * leave: strings, heredocs, shadowing imports, constant-expression contexts,
 * `__halt_compiler` files) and `Bfwc\Pgsql\Includes`, the `file://` wrapper,
 * passing every file operation through to the native one with PHP's own error
 * text. Offline; no database.
 */
import { describe, expect, it } from 'vitest';
import { phpHost, readAll } from './php-helpers.js';

const SLOW = 120_000;

/** Run `php main.php` over `files`; its output and exit code. */
async function runPhp(files: Record<string, string>): Promise<{ output: string; code: number }> {
  const { processes } = phpHost(files);
  try {
    const proc = processes.run('php', ['main.php']);
    const output = await readAll(proc.combinedOutput);
    return { output, code: await proc.wait() };
  } finally {
    processes.dispose();
  }
}

const F = '\\Bfwc\\Pgsql\\pdo';
const C = '\\Bfwc\\Pgsql\\connect';
const CASES: Array<[string, string]> = [
  ['<?php $a = new PDO($d);', `<?php $a = ${F}($d);`],
  ['<?php $a = new \\PDO ( $d );', `<?php $a = ${F}( $d );`],
  ['<?php $a = new PDO(dsn: $d, username: $u, ...$rest);', `<?php $a = ${F}(dsn: $d, username: $u, ...$rest);`],
  ['<?php $a = new PDO\n($d); echo __LINE__;', `<?php $a = ${F}\n($d); echo __LINE__;`],
  ['<?php namespace App; $a = new PDO($d);', '<?php namespace App; $a = new PDO($d);'],
  ['<?php namespace App; use PDO; $a = new PDO($d); $f = function () use ($d) { return new PDO($d); };', `<?php namespace App; use PDO; $a = ${F}($d); $f = function () use ($d) { return ${F}($d); };`],
  ['<?php namespace App; use PDO as Db; $a = new Db($d); $b = Db::connect($d);', `<?php namespace App; use PDO as Db; $a = ${F}($d); $b = ${C}($d);`],
  ['<?php $a = PDO::connect($d); $b = \\PDO::CONNECT($d); $c = PDO::ATTR_ERRMODE;', `<?php $a = ${C}($d); $b = ${C}($d); $c = PDO::ATTR_ERRMODE;`],
  ['<?php namespace App { use PDO; $a = new PDO($d); } namespace { $b = new PDO($d); }', `<?php namespace App { use PDO; $a = ${F}($d); } namespace { $b = ${F}($d); }`],
  // Shadowing imports: these PDOs are not the global one.
  ['<?php use Foo\\PDO; $a = new PDO($d);', '<?php use Foo\\PDO; $a = new PDO($d);'],
  ['<?php use Other as PDO; $a = new PDO($d); $b = new \\PDO($d);', `<?php use Other as PDO; $a = new PDO($d); $b = ${F}($d);`],
  // A trait 'use' inside a class is not an import.
  ['<?php class A { use PDO; } $a = new PDO($d);', `<?php class A { use PDO; } $a = ${F}($d);`],
  // Constant-expression contexts keep the native construction.
  ['<?php function f(PDO $p = new PDO("sqlite::memory:")) { return new PDO($d); }', `<?php function f(PDO $p = new PDO("sqlite::memory:")) { return ${F}($d); }`],
  ['<?php $f = fn ($p = new PDO("sqlite::memory:")) => new PDO($d);', `<?php $f = fn ($p = new PDO("sqlite::memory:")) => ${F}($d);`],
  ['<?php #[Attr(new PDO("x"))] function g() {} const P = new PDO("sqlite::memory:"); $a = new PDO($d);', `<?php #[Attr(new PDO("x"))] function g() {} const P = new PDO("sqlite::memory:"); $a = ${F}($d);`],
  ['<?php function h() { static $p = new PDO("sqlite::memory:"); return new PDO($d); }', `<?php function h() { static $p = new PDO("sqlite::memory:"); return ${F}($d); }`],
  // Strings, heredocs, nowdocs and comments are text.
  ['<?php echo "new PDO("; // new PDO(\n$s = <<<SQL\nnew PDO($x)\nSQL;\n$t = <<<\'T\'\nnew PDO(\nT;\n', '<?php echo "new PDO("; // new PDO(\n$s = <<<SQL\nnew PDO($x)\nSQL;\n$t = <<<\'T\'\nnew PDO(\nT;\n'],
  ['<?php $a = new PDOStatement(); class X extends PDO {}', '<?php $a = new PDOStatement(); class X extends PDO {}'],
  ['<?php $a = new PDO($d); __HALT_COMPILER(); data', '<?php $a = new PDO($d); __HALT_COMPILER(); data'],
];

describe('Bfwc\\Pgsql\\Rewriter', () => {
  it('rewrites only constructions (and PDO::connect) of the global PDO outside constant expressions, keeping line numbers', { timeout: SLOW }, async () => {
    const main = `<?php\n$cases = json_decode(<<<'JSON'\n${JSON.stringify(CASES.map(([source]) => source))}\nJSON, true);\necho json_encode(array_map([Bfwc\\Pgsql\\Rewriter::class, 'rewrite'], $cases));\n`;
    const { output, code } = await runPhp({ 'main.php': main });
    expect(code, output).toBe(0);
    const results = JSON.parse(output) as string[];
    CASES.forEach(([source, expected], i) => expect(results[i], source).toBe(expected));
  });

  it('a rewritten include compiles and runs: the constant-expression default stays native, the call reaches the runtime PDO', { timeout: SLOW }, async () => {
    const lib = `<?php
function driverOf(PDO $p = new PDO('sqlite::memory:')): string { return $p->getAttribute(PDO::ATTR_DRIVER_NAME); }
function attempt(): string { try { new PDO('pgsql:host=localhost;port=5999;dbname=x;connect_timeout=1'); return 'connected'; } catch (PDOException $e) { return get_class($e) . ' ' . __LINE__; } }
`;
    const { output, code } = await runPhp({ 'lib.php': lib, 'main.php': `<?php require 'lib.php'; echo driverOf(), ' ', attempt();` });
    expect(code, output).toBe(0);
    expect(output).toBe('sqlite Bfwc\\Pgsql\\Exception 3');
  });
});

describe('Bfwc\\Pgsql\\Includes (the file:// wrapper)', () => {
  it('passes file operations through: scandir, flock, touch/filemtime, lstat/is_link, ftruncate, rename, mkdir/rmdir, unlink', { timeout: SLOW }, async () => {
    const main = String.raw`<?php
$out = [];
mkdir('d/e', 0777, true);
file_put_contents('d/a.txt', 'hello world');
$out[] = scandir('d');
$h = fopen('d/a.txt', 'r+');
$out[] = [flock($h, LOCK_EX), ftruncate($h, 5), flock($h, LOCK_UN)];
fclose($h);
$out[] = file_get_contents('d/a.txt');
$out[] = [touch('d/a.txt', 1000000000), filemtime('d/a.txt')];
clearstatcache();
symlink(__DIR__ . '/d/a.txt', 'd/link');
$out[] = [is_link('d/link'), (lstat('d/link')['mode'] & 0170000) === 0120000, file_get_contents('d/link')];
$out[] = [rename('d/a.txt', 'd/b.txt'), file_exists('d/a.txt'), unlink('d/link'), unlink('d/b.txt'), rmdir('d/e'), rmdir('d'), is_dir('d')];
echo json_encode($out);
`;
    const { output, code } = await runPhp({ 'main.php': main });
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toEqual([['.', '..', 'a.txt', 'e'], [true, true, true], 'hello', [true, 1000000000], [true, true, 'hello'], [true, false, true, true, true, true, false]]);
  });

  it("keeps PHP's own error text and path for a missing file, and a missing include", { timeout: SLOW }, async () => {
    const { output } = await runPhp({ 'main.php': "<?php\n$r = file_get_contents('/project/nope.txt');\nvar_dump($r);\ninclude '/project/missing.php';\necho \"after\\n\";\n" });
    expect(output).toContain('/project/nope.txt');
    expect(output).toContain('No such file or directory');
    expect(output).toContain('bool(false)');
    expect(output).toContain('/project/missing.php');
    expect(output).toContain('after');
  });
});
