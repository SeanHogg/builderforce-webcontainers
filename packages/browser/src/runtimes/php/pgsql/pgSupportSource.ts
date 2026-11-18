/**
 * What the `pg_*` functions (pgFunctionsSource.ts) stand on: the extension's
 * opaque `PgSql\Connection` and its `PgSql\Result`, and `Bfwc\Pgsql\Pg`, which
 * keeps each connection's state — its wire client and its settings, password
 * included — in a WeakMap, so nothing secret is a property a `var_dump` or
 * `print_r` of the connection shows. Autoloaded on the first `pg_*` call.
 */
export const PG_SUPPORT_SOURCE = String.raw`<?php
namespace PgSql {
    final class Connection
    {
    }

    final class Result
    {
        /** @internal */
        public int $cursor = 0;

        /** @internal */
        public function __construct(public array $fields, public array $rows, public int $affected, public string $command, public ?Connection $connection = null)
        {
        }
    }
}

namespace Bfwc\Pgsql {
    use PgSql;

    /** @internal The pg_* functions' shared work. */
    final class Pg
    {
        public static ?PgSql\Connection $last = null;
        /** @var array<string, PgSql\Connection> open connections by a hash of their connection string (reused, as the extension does) */
        private static array $open = [];
        private static ?\WeakMap $state = null;
        private const TYPES = [16 => 'bool', 17 => 'bytea', 18 => 'char', 19 => 'name', 20 => 'int8', 21 => 'int2', 23 => 'int4', 25 => 'text', 26 => 'oid', 114 => 'json', 700 => 'float4', 701 => 'float8', 1042 => 'bpchar', 1043 => 'varchar', 1082 => 'date', 1083 => 'time', 1114 => 'timestamp', 1184 => 'timestamptz', 1186 => 'interval', 1700 => 'numeric', 2950 => 'uuid', 3802 => 'jsonb'];

        /** A connection's state: wire (null once closed or broken), config, key, lastError, verbosity. */
        public static function state(PgSql\Connection $connection): object
        {
            return (self::$state ??= new \WeakMap())[$connection];
        }

        /** pg_connect's conninfo ('host=… dbname=…', values optionally quoted with \' and \\ escapes) or URI ('postgresql://user:pass@host:port/db'). */
        public static function connect(string $conninfo, int $flags): PgSql\Connection|false
        {
            $key = hash('sha256', $conninfo);
            $reuse = self::$open[$key] ?? null;
            if ($reuse && self::state($reuse)->wire && !($flags & PGSQL_CONNECT_FORCE_NEW)) {
                return self::$last = $reuse;
            }
            $config = [];
            if (preg_match('#^postgres(?:ql)?://#', $conninfo)) {
                $url = parse_url($conninfo);
                $config = array_filter(['host' => $url['host'] ?? null, 'port' => $url['port'] ?? null, 'user' => isset($url['user']) ? urldecode($url['user']) : null, 'password' => isset($url['pass']) ? urldecode($url['pass']) : null, 'dbname' => ltrim($url['path'] ?? '', '/') ?: null], static fn ($value) => $value !== null);
            } else {
                preg_match_all("/(\\w+)\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|\\S+)/", $conninfo, $pairs, PREG_SET_ORDER);
                foreach ($pairs as [, $name, $value]) {
                    $config[strtolower($name)] = str_starts_with($value, "'") ? preg_replace("/\\\\(['\\\\])/", '$1', substr($value, 1, -1)) : $value;
                }
            }
            try {
                $wire = Wire::fromConfig($config);
            } catch (Exception $exception) {
                trigger_error('pg_connect(): Unable to connect to PostgreSQL server: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
            $connection = new PgSql\Connection();
            self::$state ??= new \WeakMap();
            self::$state[$connection] = (object) ['wire' => $wire, 'config' => $config, 'key' => $key, 'lastError' => '', 'verbosity' => PGSQL_ERRORS_DEFAULT];
            return self::$last = self::$open[$key] = $connection;
        }

        /** The connection to use ($connection, else the last opened), with an open wire. */
        public static function of(?PgSql\Connection $connection): PgSql\Connection
        {
            $connection ??= self::$last;
            if (!$connection) {
                throw new \Error('No PostgreSQL connection opened yet');
            }
            if (!self::state($connection)->wire) {
                throw new \Error('PostgreSQL connection has already been closed');
            }
            return $connection;
        }

        public static function wire(?PgSql\Connection $connection): Wire
        {
            return self::state(self::of($connection))->wire;
        }

        public static function close(?PgSql\Connection $connection): void
        {
            $connection = self::of($connection);
            $state = self::state($connection);
            $state->wire->close();
            $state->wire = null;
            if ((self::$open[$state->key] ?? null) === $connection) {
                unset(self::$open[$state->key]);
            }
            if (self::$last === $connection) {
                self::$last = null;
            }
        }

        /** Reconnect with the same settings. */
        public static function reset(PgSql\Connection $connection): bool
        {
            $state = self::state($connection);
            $state->wire?->close();
            try {
                $state->wire = Wire::fromConfig($state->config);
                return true;
            } catch (Exception) {
                $state->wire = null;
                return false;
            }
        }

        /** Run $sql: a simple query when $params is null, a named prepared statement when $prepared; failures warn and return false. */
        public static function run(PgSql\Connection $connection, string $function, string $sql, ?array $params, bool $prepared = false): PgSql\Result|false
        {
            $state = self::state($connection);
            try {
                $values = $params === null ? null : array_map(static fn ($value) => Wire::text($value, '1', ''), array_values($params));
                $result = match (true) {
                    $prepared => $state->wire->executePrepared($sql, $values ?? []),
                    $values === null => $state->wire->simple($sql),
                    default => $state->wire->execute($sql, $values),
                };
                $state->lastError = '';
                return new PgSql\Result($result['fields'], $result['rows'], $result['affected'], $result['command'], $connection);
            } catch (Exception $exception) {
                $state->lastError = $exception->errorInfo[2];
                $code = (string) $exception->errorInfo[0];
                if (str_starts_with($code, '08') || str_starts_with($code, '57P')) {
                    // A broken connection (or a terminated backend) reports CONNECTION_BAD from now on, as libpq's does.
                    $state->wire->close();
                    $state->wire = null;
                }
                trigger_error($function . '(): Query failed: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
        }

        public static function prepare(PgSql\Connection $connection, string $name, string $sql): PgSql\Result|false
        {
            $state = self::state($connection);
            try {
                $result = $state->wire->prepare($name, $sql);
                $state->lastError = '';
                return new PgSql\Result([], [], 0, $result['command'], $connection);
            } catch (Exception $exception) {
                $state->lastError = $exception->errorInfo[2];
                trigger_error('pg_prepare(): Query failed: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
        }

        /** Row $row (the cursor's when null, which then advances) shaped by $mode; false past the end. */
        public static function row(PgSql\Result $result, ?int $row, int $mode, bool $advance = true): array|false
        {
            $index = $row ?? $result->cursor;
            if (!isset($result->rows[$index])) {
                return false;
            }
            if ($advance) {
                $result->cursor = $index + 1;
            }
            $values = $result->rows[$index];
            if ($mode === PGSQL_NUM) {
                return $values;
            }
            $out = [];
            foreach ($result->fields as $i => $field) {
                if ($mode !== PGSQL_ASSOC) {
                    $out[$i] = $values[$i];
                }
                $out[$field['name']] = $values[$i];
            }
            return $out;
        }

        /** Field $field (index or name) of $result, or a ValueError naming $function's argument $argument, as the extension throws. */
        public static function field(PgSql\Result $result, int|string $field, string $function, int $argument): int
        {
            if (is_int($field)) {
                if ($field < 0 || $field >= count($result->fields)) {
                    throw new \ValueError($function . '(): Argument #' . $argument . ' ($field) must be less than the number of fields for this result set');
                }
                return $field;
            }
            $at = array_search($field, array_column($result->fields, 'name'), true);
            if ($at === false) {
                throw new \ValueError($function . '(): Argument #' . $argument . ' ($field) must be a field name from this result set');
            }
            return $at;
        }

        /** The value at $row (null: the cursor's row, which then advances) and $field, or false (with the extension's warning) past the rows. */
        public static function value(PgSql\Result $result, ?int $row, int|string $field, string $function): string|false|null
        {
            $index = $row ?? $result->cursor++;
            $column = self::field($result, $field, $function, $row === null ? 2 : 3);
            if (!isset($result->rows[$index])) {
                trigger_error($function . '(): Unable to jump to row ' . $index . ' on PostgreSQL result index', E_USER_WARNING);
                return false;
            }
            return $result->rows[$index][$column];
        }

        public static function typeName(int $oid): string
        {
            return self::TYPES[$oid] ?? 'unknown';
        }

        public static function quote(string $value, string $quote): string
        {
            return $quote . str_replace($quote, $quote . $quote, $value) . $quote;
        }

        /** The connection and the remaining argument of a function whose leading connection is optional. */
        public static function split(mixed $first, mixed $second): array
        {
            return $second === null ? [self::of(null), $first] : [self::of($first), $second];
        }
    }
}
`;
