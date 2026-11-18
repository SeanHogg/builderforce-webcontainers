/**
 * The runtime's own PHP code, written into php-wasm outside the project mount
 * (never synced to the page) and made available to every script without a
 * `require`: php-wasm's auto-prepended script registers an autoloader for the
 * `Bfwc\Pgsql\` classes (pgsql/: the Postgres wire client and the PDO on it),
 * so `new \Bfwc\Pgsql\PDO('pgsql:…')` works in `php script.php`, `php -r` and
 * every `php -S` request, and costs nothing until used.
 */
import { exists } from '../emscripten/projectMirror.js';
import type { WrappableEmscriptenFs } from '../emscripten/wrappedFsWrites.js';
import { PDO_SOURCE } from './pgsql/pdoSource.js';
import { STATEMENT_SOURCE } from './pgsql/statementSource.js';
import { WIRE_SOURCE } from './pgsql/wireSource.js';

export const RUNTIME_LIBRARY_ROOT = '/bfwc';

/** The script php-wasm's php.ini auto-prepends (php-wasm writes it at start-up). */
export const PHP_WASM_AUTO_PREPEND = '/internal/shared/auto_prepend_file.php';

const PREPEND = `<?php
spl_autoload_register(static function (string $class): void {
    static $files = ['Bfwc\\\\Pgsql\\\\Wire' => 'wire.php', 'Bfwc\\\\Pgsql\\\\Exception' => 'wire.php', 'Bfwc\\\\Pgsql\\\\PDO' => 'pdo.php', 'Bfwc\\\\Pgsql\\\\Statement' => 'statement.php'];
    if (isset($files[$class])) {
        require_once '${RUNTIME_LIBRARY_ROOT}/pgsql/' . $files[$class];
    }
});
`;

const FILES: Readonly<Record<string, string>> = {
  'prepend.php': PREPEND,
  'pgsql/wire.php': WIRE_SOURCE,
  'pgsql/pdo.php': PDO_SOURCE,
  'pgsql/statement.php': STATEMENT_SOURCE,
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
