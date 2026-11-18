/**
 * The `pgsql` extension's functions (`pg_connect`, `pg_query`,
 * `pg_query_params`, `pg_fetch_*` …) and its `PgSql\Connection` /
 * `PgSql\Result` classes, defined in PHP on the runtime's wire client
 * (wireSource.ts) because php-wasm has no `pgsql` extension. Loaded by the
 * auto-prepended script only when `pg_connect` does not exist. Values come back
 * as the extension returns them: text (`'t'`/`'f'` for booleans) or null.
 * Failures warn and return false, as the extension does.
 */
export const PG_FUNCTIONS_SOURCE = String.raw`<?php
namespace PgSql {
    final class Connection
    {
        public array $prepared = [];
        public string $lastError = '';

        public function __construct(public ?\Bfwc\Pgsql\Wire $wire)
        {
        }
    }

    final class Result
    {
        public int $cursor = 0;

        public function __construct(public array $fields, public array $rows, public int $affected)
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

        /** pg_connect's conninfo ('host=… dbname=…') or URI ('postgresql://user:pass@host:port/db'). */
        public static function connect(string $conninfo): PgSql\Connection|false
        {
            $config = [];
            if (preg_match('#^postgres(?:ql)?://#', $conninfo)) {
                $url = parse_url($conninfo);
                $config = ['host' => $url['host'] ?? 'localhost', 'port' => $url['port'] ?? 5432, 'user' => isset($url['user']) ? urldecode($url['user']) : null, 'password' => isset($url['pass']) ? urldecode($url['pass']) : null, 'dbname' => ltrim($url['path'] ?? '', '/') ?: null];
            } else {
                preg_match_all("/(\\w+)\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|\\S+)/", $conninfo, $pairs, PREG_SET_ORDER);
                foreach ($pairs as [, $key, $value]) {
                    $config[strtolower($key)] = str_starts_with($value, "'") ? stripcslashes(substr($value, 1, -1)) : $value;
                }
            }
            $user = $config['user'] ?? 'postgres';
            try {
                $wire = new \Bfwc\Pgsql\Wire($config['host'] ?? 'localhost', (int) ($config['port'] ?? 5432), $user, $config['dbname'] ?? $user, $config['password'] ?? null, (float) ($config['connect_timeout'] ?? 30));
            } catch (\Bfwc\Pgsql\Exception $exception) {
                trigger_error('pg_connect(): Unable to connect to PostgreSQL server: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
            return self::$last = new PgSql\Connection($wire);
        }

        public static function of(?PgSql\Connection $connection, string $function): PgSql\Connection
        {
            $connection ??= self::$last;
            if (!$connection || !$connection->wire) {
                throw new \TypeError($function . '(): no PostgreSQL connection opened yet');
            }
            return $connection;
        }

        public static function run(PgSql\Connection $connection, string $function, string $sql, ?array $params): PgSql\Result|false
        {
            try {
                $values = $params === null ? null : array_map(static fn ($v) => $v === null ? null : (is_bool($v) ? ($v ? 't' : 'f') : (string) $v), array_values($params));
                $result = $values === null ? $connection->wire->simple($sql) : $connection->wire->execute($sql, $values);
                $connection->lastError = '';
                return new PgSql\Result($result['fields'], $result['rows'], $result['affected']);
            } catch (\Bfwc\Pgsql\Exception $exception) {
                $connection->lastError = $exception->errorInfo[2];
                trigger_error($function . '(): Query failed: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
        }

        public static function row(PgSql\Result $result, ?int $row, int $mode): array|false
        {
            $index = $row ?? $result->cursor;
            if (!isset($result->rows[$index])) {
                return false;
            }
            $result->cursor = $index + 1;
            $values = $result->rows[$index];
            $assoc = array_combine(array_column($result->fields, 'name'), $values);
            return match ($mode) {
                PGSQL_ASSOC => $assoc,
                PGSQL_NUM => $values,
                default => $values + $assoc,
            };
        }

        public static function quote(string $value, string $quote): string
        {
            return $quote . str_replace($quote, $quote . $quote, $value) . $quote;
        }
    }
}

namespace {
    const PGSQL_ASSOC = 1;
    const PGSQL_NUM = 2;
    const PGSQL_BOTH = 3;
    const PGSQL_CONNECTION_OK = 0;
    const PGSQL_CONNECTION_BAD = 1;
    const PGSQL_TRANSACTION_IDLE = 0;
    const PGSQL_TRANSACTION_INTRANS = 2;
    const PGSQL_TRANSACTION_INERROR = 3;
    const PGSQL_TRANSACTION_UNKNOWN = 4;

    function pg_connect(string $connection_string, int $flags = 0): PgSql\Connection|false { return \Bfwc\Pgsql\Pg::connect($connection_string); }
    function pg_pconnect(string $connection_string, int $flags = 0): PgSql\Connection|false { return \Bfwc\Pgsql\Pg::connect($connection_string); }
    function pg_close(?PgSql\Connection $connection = null): bool
    {
        $connection = \Bfwc\Pgsql\Pg::of($connection, 'pg_close');
        $connection->wire->close();
        $connection->wire = null;
        if (\Bfwc\Pgsql\Pg::$last === $connection) {
            \Bfwc\Pgsql\Pg::$last = null;
        }
        return true;
    }
    function pg_query($connection, ?string $query = null): PgSql\Result|false
    {
        return $query === null ? \Bfwc\Pgsql\Pg::run(\Bfwc\Pgsql\Pg::of(null, 'pg_query'), 'pg_query', $connection, null) : \Bfwc\Pgsql\Pg::run(\Bfwc\Pgsql\Pg::of($connection, 'pg_query'), 'pg_query', $query, null);
    }
    function pg_query_params($connection, $query, ?array $params = null): PgSql\Result|false
    {
        return $params === null ? \Bfwc\Pgsql\Pg::run(\Bfwc\Pgsql\Pg::of(null, 'pg_query_params'), 'pg_query_params', $connection, $query) : \Bfwc\Pgsql\Pg::run(\Bfwc\Pgsql\Pg::of($connection, 'pg_query_params'), 'pg_query_params', $query, $params);
    }
    function pg_prepare($connection, string $name, ?string $query = null): PgSql\Result|false
    {
        [$connection, $name, $query] = $query === null ? [\Bfwc\Pgsql\Pg::of(null, 'pg_prepare'), $connection, $name] : [\Bfwc\Pgsql\Pg::of($connection, 'pg_prepare'), $name, $query];
        $connection->prepared[$name] = $query;
        return new PgSql\Result([], [], 0);
    }
    function pg_execute($connection, $name, ?array $params = null): PgSql\Result|false
    {
        [$connection, $name, $params] = $params === null ? [\Bfwc\Pgsql\Pg::of(null, 'pg_execute'), $connection, $name] : [\Bfwc\Pgsql\Pg::of($connection, 'pg_execute'), $name, $params];
        if (!isset($connection->prepared[$name])) {
            trigger_error('pg_execute(): Query failed: ERROR:  prepared statement "' . $name . '" does not exist', E_USER_WARNING);
            return false;
        }
        return \Bfwc\Pgsql\Pg::run($connection, 'pg_execute', $connection->prepared[$name], $params);
    }
    function pg_fetch_assoc(PgSql\Result $result, ?int $row = null): array|false { return \Bfwc\Pgsql\Pg::row($result, $row, PGSQL_ASSOC); }
    function pg_fetch_row(PgSql\Result $result, ?int $row = null, int $mode = PGSQL_NUM): array|false { return \Bfwc\Pgsql\Pg::row($result, $row, $mode); }
    function pg_fetch_array(PgSql\Result $result, ?int $row = null, int $mode = PGSQL_BOTH): array|false { return \Bfwc\Pgsql\Pg::row($result, $row, $mode); }
    function pg_fetch_object(PgSql\Result $result, ?int $row = null, string $class = 'stdClass', array $constructor_args = []): object|false
    {
        $values = \Bfwc\Pgsql\Pg::row($result, $row, PGSQL_ASSOC);
        if ($values === false) {
            return false;
        }
        $object = $class === 'stdClass' ? new stdClass() : new $class(...$constructor_args);
        foreach ($values as $name => $value) {
            $object->$name = $value;
        }
        return $object;
    }
    function pg_fetch_all(PgSql\Result $result, int $mode = PGSQL_ASSOC): array
    {
        $rows = [];
        foreach (array_keys($result->rows) as $index) {
            $rows[] = \Bfwc\Pgsql\Pg::row($result, $index, $mode);
        }
        return $rows;
    }
    function pg_fetch_all_columns(PgSql\Result $result, int $field = 0): array { return array_column($result->rows, $field); }
    function pg_fetch_result(PgSql\Result $result, $row, $field = null): string|false|null
    {
        [$row, $field] = $field === null ? [$result->cursor, $row] : [$row, $field];
        $column = is_int($field) ? $field : array_search($field, array_column($result->fields, 'name'), true);
        return $column === false || !isset($result->rows[$row]) ? false : $result->rows[$row][$column];
    }
    function pg_num_rows(PgSql\Result $result): int { return count($result->rows); }
    function pg_num_fields(PgSql\Result $result): int { return count($result->fields); }
    function pg_field_name(PgSql\Result $result, int $field): string { return $result->fields[$field]['name']; }
    function pg_field_num(PgSql\Result $result, string $field): int { $at = array_search($field, array_column($result->fields, 'name'), true); return $at === false ? -1 : $at; }
    function pg_affected_rows(PgSql\Result $result): int { return $result->affected; }
    function pg_free_result(PgSql\Result $result): bool { $result->rows = []; return true; }
    function pg_result_seek(PgSql\Result $result, int $row): bool { if (!isset($result->rows[$row])) return false; $result->cursor = $row; return true; }
    function pg_last_error(?PgSql\Connection $connection = null): string { return \Bfwc\Pgsql\Pg::of($connection, 'pg_last_error')->lastError; }
    function pg_escape_string($connection, ?string $string = null): string { return str_replace("'", "''", $string ?? $connection); }
    function pg_escape_literal($connection, ?string $string = null): string { return \Bfwc\Pgsql\Pg::quote($string ?? $connection, "'"); }
    function pg_escape_identifier($connection, ?string $string = null): string { return \Bfwc\Pgsql\Pg::quote($string ?? $connection, '"'); }
    function pg_connection_status(PgSql\Connection $connection): int { return $connection->wire ? PGSQL_CONNECTION_OK : PGSQL_CONNECTION_BAD; }
    function pg_transaction_status(PgSql\Connection $connection): int
    {
        return match ($connection->wire?->status) { 'I' => PGSQL_TRANSACTION_IDLE, 'T' => PGSQL_TRANSACTION_INTRANS, 'E' => PGSQL_TRANSACTION_INERROR, default => PGSQL_TRANSACTION_UNKNOWN };
    }
    function pg_parameter_status($connection, ?string $name = null): string|false
    {
        [$connection, $name] = $name === null ? [\Bfwc\Pgsql\Pg::of(null, 'pg_parameter_status'), $connection] : [\Bfwc\Pgsql\Pg::of($connection, 'pg_parameter_status'), $name];
        return $connection->wire->parameters[$name] ?? false;
    }
    function pg_version(?PgSql\Connection $connection = null): array
    {
        $connection = \Bfwc\Pgsql\Pg::of($connection, 'pg_version');
        return ['client' => 'bfwc-pgsql', 'protocol' => 3, 'server' => $connection->wire->parameters['server_version'] ?? ''];
    }
    function pg_ping(?PgSql\Connection $connection = null): bool { return \Bfwc\Pgsql\Pg::of($connection, 'pg_ping')->wire !== null; }
}
`;
