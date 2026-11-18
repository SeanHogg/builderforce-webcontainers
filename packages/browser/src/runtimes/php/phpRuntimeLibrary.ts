/**
 * The runtime's own PHP code, written into php-wasm outside the project mount
 * (never synced to the page) and made available to every script without a
 * `require`: php-wasm's auto-prepended script registers an autoloader for the
 * `Bfwc\Pgsql\` classes (pgsql/: the Postgres wire client and the PDO on it),
 * installs the include rewrite that makes an unmodified `new PDO('pgsql:…')`
 * reach that PDO (pgsql/includesSource.ts), and defines the `pg_*` functions
 * when the `pgsql` extension is absent (pgsql/pgFunctionsSource.ts) — in
 * `php script.php`, `php -S` requests and `\Bfwc\Pgsql\PDO` directly alike.
 */
import { exists } from '../emscripten/projectMirror.js';
import type { WrappableEmscriptenFs } from '../emscripten/wrappedFsWrites.js';
import { INCLUDES_SOURCE } from './pgsql/includesSource.js';
import { PDO_SOURCE } from './pgsql/pdoSource.js';
import { PG_FUNCTIONS_SOURCE } from './pgsql/pgFunctionsSource.js';
import { STATEMENT_SOURCE } from './pgsql/statementSource.js';
import { WIRE_SOURCE } from './pgsql/wireSource.js';

export const RUNTIME_LIBRARY_ROOT = '/bfwc';

/** The script php-wasm's php.ini auto-prepends (php-wasm writes it at start-up). */
export const PHP_WASM_AUTO_PREPEND = '/internal/shared/auto_prepend_file.php';

// Required at the top level of the auto-prepended script, so a CLI script it runs (rewritten) sees the global scope.
const PREPEND = `<?php
spl_autoload_register(static function (string $class): void {
    static $files = ['Bfwc\\\\Pgsql\\\\Wire' => 'wire.php', 'Bfwc\\\\Pgsql\\\\Exception' => 'wire.php', 'Bfwc\\\\Pgsql\\\\PDO' => 'pdo.php', 'Bfwc\\\\Pgsql\\\\Statement' => 'statement.php'];
    if (isset($files[$class])) {
        require_once '${RUNTIME_LIBRARY_ROOT}/pgsql/' . $files[$class];
    }
});
require_once '${RUNTIME_LIBRARY_ROOT}/pgsql/includes.php';
if (!function_exists('pg_connect')) {
    require_once '${RUNTIME_LIBRARY_ROOT}/pgsql/functions.php';
}
\\Bfwc\\Pgsql\\Includes::register();
if (\\Bfwc\\Pgsql\\Includes::rewritesPrimary()) {
    require $_SERVER['SCRIPT_FILENAME'];
    exit;
}
`;

const FILES: Readonly<Record<string, string>> = {
  'prepend.php': PREPEND,
  'pgsql/wire.php': WIRE_SOURCE,
  'pgsql/pdo.php': PDO_SOURCE,
  'pgsql/statement.php': STATEMENT_SOURCE,
  'pgsql/includes.php': INCLUDES_SOURCE,
  'pgsql/functions.php': PG_FUNCTIONS_SOURCE,
};

/** Write the library and hook it into php-wasm's auto-prepended script (before the project is tracked). */
export function installRuntimeLibrary(FS: WrappableEmscriptenFs): void {
  for (const [path, source] of Object.entries(FILES)) {
    const target = `${RUNTIME_LIBRARY_ROOT}/${path}`;
    FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
    FS.writeFile(target, source);
  }
  const hook = `\nrequire_once '${RUNTIME_LIBRARY_ROOT}/prepend.php';\n`;
  const current = exists(FS, PHP_WASM_AUTO_PREPEND) ? new TextDecoder().decode(FS.readFile(PHP_WASM_AUTO_PREPEND)) : '<?php\n';
  if (!current.includes(hook)) FS.writeFile(PHP_WASM_AUTO_PREPEND, `${current.replace(/\?>\s*$/, '')}${hook}`);
}
