/**
 * PHP 8.4's `Pdo\Pgsql` (the driver subclass `PDO::connect()` returns), for
 * php-wasm builds without pdo_pgsql: a subclass of the runtime's PDO
 * (pdoSource.ts), declared only on PHP 8.4+ and only when the class is absent
 * (the autoloader never runs for a class that exists). So `new Pdo\Pgsql(…)`,
 * `instanceof Pdo\Pgsql` and the `Pdo\Pgsql::ATTR_*` constants work.
 *
 * Methods: `escapeIdentifier`, `getPid`, and all of `\PDO`'s. Absent (they
 * throw "undefined method"): `copyFromArray`, `copyFromFile`, `copyToArray`,
 * `copyToFile`, `lobCreate`, `lobOpen`, `lobUnlink`, `getNotify`,
 * `setNoticeCallback`.
 */
export const PDO_PGSQL_SOURCE = String.raw`<?php
namespace Pdo;

if (PHP_VERSION_ID >= 80400 && !class_exists(Pgsql::class, false)) {
    class Pgsql extends \Bfwc\Pgsql\PDO
    {
        public function escapeIdentifier(string $input): string
        {
            return '"' . str_replace('"', '""', $input) . '"';
        }

        public function getPid(): int
        {
            return $this->bfwcWire()->pid;
        }
    }
}
`;
