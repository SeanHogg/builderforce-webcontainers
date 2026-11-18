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
async function runPhp(files: Record<string, string>, phpVersion?: string): Promise<{ output: string; code: number }> {
  const { processes } = phpHost(files, {}, phpVersion ? { php: { phpVersion } } : {});
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
  // Strings, heredocs, nowdocs and comments are text.
  ['<?php echo "new PDO("; // new PDO(\n$s = <<<SQL\nnew PDO($x)\nSQL;\n$t = <<<\'T\'\nnew PDO(\nT;\n', '<?php echo "new PDO("; // new PDO(\n$s = <<<SQL\nnew PDO($x)\nSQL;\n$t = <<<\'T\'\nnew PDO(\nT;\n'],
  // CANDIDATE catches comments between new and the name, and lists of imports.
  ['<?php $a = new /* c */ PDO($d);', `<?php $a = ${F}($d);`],
  ['<?php namespace App; use Foo, PDO as Db; $a = new Db($d);', `<?php namespace App; use Foo, PDO as Db; $a = ${F}($d);`],
  // PHP 8.4's Pdo\Pgsql: construction needs no rewrite (the runtime declares the class), connect does.
  ['<?php $a = new Pdo\\Pgsql($d); $b = Pdo\\Pgsql::connect($d); $c = \\Pdo\\Pgsql::connect($d);', `<?php $a = new Pdo\\Pgsql($d); $b = ${C}($d); $c = ${C}($d);`],
  ['<?php namespace App; use Pdo\\Pgsql; $b = Pgsql::connect($d); $c = Other\\Pgsql::connect($d);', `<?php namespace App; use Pdo\\Pgsql; $b = ${C}($d); $c = Other\\Pgsql::connect($d);`],
  ['<?php $a = new PDOStatement(); class X extends PDO {}', '<?php $a = new PDOStatement(); class X extends PDO {}'],
  ['<?php $a = new PDO($d); __HALT_COMPILER(); data', '<?php $a = new PDO($d); __HALT_COMPILER(); data'],
];

describe('Bfwc\\Pgsql\\Rewriter', () => {
  it.each(['8.2', '8.3', '8.4'])('PHP %s: rewrites only constructions (and PDO::connect) of the global PDO outside constant expressions, keeping line numbers', { timeout: SLOW }, async (phpVersion) => {
    // 'static $x = new …' is a constant expression only before PHP 8.3 (which allows any expression there).
    const STATIC = '<?php function h() { if ($x) static $p = new PDO($d); else static $q = new PDO($d); return new PDO($d); }';
    const all = [...CASES.map(([source]) => source), STATIC];
    const main = `<?php\n$cases = json_decode(<<<'JSON'\n${JSON.stringify(all)}\nJSON, true);\necho json_encode([PHP_VERSION_ID, array_map([Bfwc\\Pgsql\\Rewriter::class, 'rewrite'], $cases)]);\n`;
    const { output, code } = await runPhp({ 'main.php': main }, phpVersion);
    expect(code, output).toBe(0);
    const [version, results] = JSON.parse(output) as [number, string[]];
    expect(Math.floor(version / 100)).toBe(Number(phpVersion.replace('.', '0')));
    CASES.forEach(([source, expected], i) => expect(results[i], source).toBe(expected));
    const kept = version >= 80300 ? F : 'new PDO';
    expect(results[CASES.length]).toBe(`<?php function h() { if ($x) static $p = ${kept}($d); else static $q = ${kept}($d); return ${F}($d); }`);
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
  it('a rewritten CLI script drops its #! line (keeping line numbers), and including a directory fails', { timeout: SLOW }, async () => {
    const main = "#!/usr/bin/env php\n<?php\n$db = new PDO('sqlite::memory:');\nmkdir('dir');\necho get_class($db), ' ', __LINE__, ' ', var_export(@include 'dir', true);\n";
    const { output, code } = await runPhp({ 'main.php': main });
    expect(code, output).toBe(0);
    expect(output).toBe('PDO 5 false');
  });

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

  it("keeps PHP's own error text and path, the warning counts, and the app's error_get_last()", { timeout: SLOW }, async () => {
    const main = String.raw`<?php
@trigger_error('the app\'s own', E_USER_NOTICE);
$warnings = [];
set_error_handler(function (int $level, string $message) use (&$warnings) { $warnings[] = $message; return true; });
$out = [];
file_exists('/project/nope.txt');
is_file(__FILE__);
file_put_contents('x.txt', 'x');
unlink('x.txt');
$out[] = error_get_last()['message'] ?? null; // untouched by the wrapper's own operations
$out[] = count($warnings);
file_get_contents('/project/nope.txt');
$out[] = $warnings;
$warnings = [];
include '/project/missing.php';
$out[] = $warnings;
$warnings = [];
$out[] = @file_get_contents('/project/nope.txt');
$out[] = $warnings;
// An exception inside a wrapper operation still restores the app's handler (and the wrapper).
try {
    (new ReflectionMethod(Bfwc\Pgsql\Includes::class, 'native'))->invoke(null, static fn () => throw new RuntimeException('inside'));
} catch (RuntimeException) {
}
$mine = set_error_handler(null);
$out[] = [$mine instanceof Closure && (new ReflectionFunction($mine))->getClosureScopeClass() === null, @file_get_contents(__FILE__) !== false];
echo json_encode($out);
`;
    const { output, code } = await runPhp({ 'main.php': main });
    expect(code, output).toBe(0);
    const [last, quiet, missingFile, missingInclude, suppressed, suppressedWarnings, restored] = JSON.parse(output) as [string, number, string[], string[], unknown, string[], boolean[]];
    expect(restored).toEqual([true, true]);
    expect(last).toBe("the app's own");
    expect(quiet).toBe(0); // the wrapper's own stats, writes and unlinks warn about nothing
    expect(missingFile).toHaveLength(2); // the native text, then PHP's "call failed"
    expect(missingFile[0]).toMatch(/\/project\/nope\.txt.*No such file or directory/);
    expect(missingInclude).toHaveLength(2); // as natively: "Failed to open stream", "Failed opening … for inclusion"
    expect(missingInclude.join('\n')).toContain('/project/missing.php');
    expect(suppressed).toBe(false);
    expect(suppressedWarnings).toHaveLength(2); // a handler still sees @-suppressed errors, as natively: the native text and "call failed"
  });

  it('caches each rewrite in one slot per file and misses on any edit, even a same-second, same-size one', { timeout: SLOW }, async () => {
    const main = String.raw`<?php
$load = new ReflectionMethod(Bfwc\Pgsql\Includes::class, 'load');
$path = __DIR__ . '/inc.php';
$out = [];
file_put_contents($path, '<?php $a = new PDO($x);');
touch($path, 1000000000);
$out[] = $load->invoke(null, $path)[0];
$slots = count(glob('/bfwc/cache/*'));
// Prove the hit: plant a sentinel in the slot under the same content hash.
$slot = '/bfwc/cache/' . md5($path);
file_put_contents($slot, md5_file($path) . '+<?php /* sentinel */');
$out[] = $load->invoke(null, $path)[0];
// A candidate that needs no rewrite stores the UNCHANGED marker only.
file_put_contents($path, '<?php namespace App; $u = new PDO($x);');
$out[] = [$load->invoke(null, $path)[2], file_get_contents($slot) === md5_file($path) . '=', $load->invoke(null, $path)[0]];
file_put_contents($path, '<?php $b = new PDO($x);'); // same size
touch($path, 1000000000); // same mtime
clearstatcache();
$out[] = $load->invoke(null, $path)[0];
file_put_contents($path, '<?php $b = new PDOX($x);');
$out[] = $load->invoke(null, $path)[2];
$out[] = count(glob('/bfwc/cache/*')) === $slots && is_file('/bfwc/cache/' . md5($path)); // still one slot for the file
echo json_encode($out);
`;
    const { output, code } = await runPhp({ 'main.php': main });
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toEqual(['<?php $a = \\Bfwc\\Pgsql\\pdo($x);', '<?php /* sentinel */', [false, true, '<?php namespace App; $u = new PDO($x);'], '<?php $b = \\Bfwc\\Pgsql\\pdo($x);', false, true]);
  });
});
