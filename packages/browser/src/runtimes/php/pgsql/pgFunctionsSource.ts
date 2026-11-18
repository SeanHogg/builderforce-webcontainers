/**
 * The `pgsql` extension's functions (`pg_connect`, `pg_query`,
 * `pg_query_params`, `pg_prepare`/`pg_execute`, `pg_fetch_*`, `pg_escape_*` …),
 * its `PGSQL_*` constants and its `PgSql\Connection` / `PgSql\Result` classes,
 * defined in PHP on the runtime's wire client (wireSource.ts) because php-wasm
 * has no `pgsql` extension. Loaded by the auto-prepended script only when
 * `pg_connect` does not exist.
 *
 * As the extension: values come back as text (`'t'`/`'f'` for booleans) or
 * null; booleans are sent as `'1'`/`''`; `pg_prepare` parses a named
 * statement on the server; `pg_connect` reuses an open connection with the
 * same connection string unless `PGSQL_CONNECT_FORCE_NEW`; `pg_fetch_object`
 * sets properties before the constructor runs; a two-argument
 * `pg_fetch_result` reads the next row. Differences: failures warn with
 * `E_USER_WARNING` (PHP code cannot raise `E_WARNING`), with the extension's
 * message; a failed query returns false, so `pg_result_error` is always '';
 * asynchronous (`pg_send_*`), COPY, large-object, notify and `pg_insert`-style
 * DML helpers are absent.
 */
export const PG_FUNCTIONS_SOURCE = String.raw`<?php
namespace PgSql {
    final class Connection
    {
        public array $prepared = [];
        public string $lastError = '';

        public function __construct(public ?\Bfwc\Pgsql\Wire $wire, public string $conninfo)
        {
        }
    }

    final class Result
    {
        public int $cursor = 0;

        public function __construct(public array $fields, public array $rows, public int $affected, public string $command)
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
        /** @var array<string, PgSql\Connection> open connections by connection string (reused, as the extension does) */
        public static array $open = [];
        private const TYPES = [16 => 'bool', 17 => 'bytea', 18 => 'char', 19 => 'name', 20 => 'int8', 21 => 'int2', 23 => 'int4', 25 => 'text', 26 => 'oid', 114 => 'json', 700 => 'float4', 701 => 'float8', 1042 => 'bpchar', 1043 => 'varchar', 1082 => 'date', 1083 => 'time', 1114 => 'timestamp', 1184 => 'timestamptz', 1186 => 'interval', 1700 => 'numeric', 2950 => 'uuid', 3802 => 'jsonb'];

        /** pg_connect's conninfo ('host=… dbname=…') or URI ('postgresql://user:pass@host:port/db'). */
        public static function connect(string $conninfo, int $flags): PgSql\Connection|false
        {
            $reuse = self::$open[$conninfo] ?? null;
            if ($reuse && $reuse->wire && !($flags & PGSQL_CONNECT_FORCE_NEW)) {
                return self::$last = $reuse;
            }
            $config = [];
            if (preg_match('#^postgres(?:ql)?://#', $conninfo)) {
                $url = parse_url($conninfo);
                $config = array_filter(['host' => $url['host'] ?? null, 'port' => $url['port'] ?? null, 'user' => isset($url['user']) ? urldecode($url['user']) : null, 'password' => isset($url['pass']) ? urldecode($url['pass']) : null, 'dbname' => ltrim($url['path'] ?? '', '/') ?: null], static fn ($value) => $value !== null);
            } else {
                preg_match_all("/(\\w+)\\s*=\\s*('(?:[^'\\\\]|\\\\.)*'|\\S+)/", $conninfo, $pairs, PREG_SET_ORDER);
                foreach ($pairs as [, $key, $value]) {
                    $config[strtolower($key)] = str_starts_with($value, "'") ? stripcslashes(substr($value, 1, -1)) : $value;
                }
            }
            try {
                $connection = new PgSql\Connection(Wire::fromConfig($config), $conninfo);
            } catch (Exception $exception) {
                trigger_error('pg_connect(): Unable to connect to PostgreSQL server: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
            return self::$last = self::$open[$conninfo] = $connection;
        }

        public static function of(?PgSql\Connection $connection, string $function): PgSql\Connection
        {
            $connection ??= self::$last;
            if (!$connection || !$connection->wire) {
                throw new \TypeError($function . '(): no PostgreSQL connection opened yet');
            }
            return $connection;
        }

        /** Run on $connection ($params null: a simple query; $prepared: a named statement); failures warn and return false. */
        public static function run(PgSql\Connection $connection, string $function, string $sql, ?array $params, bool $prepared = false): PgSql\Result|false
        {
            try {
                $values = $params === null ? null : array_map(static fn ($value) => Wire::text($value, '1', ''), array_values($params));
                $result = match (true) {
                    $prepared => $connection->wire->executePrepared($sql, $values ?? []),
                    $values === null => $connection->wire->simple($sql),
                    default => $connection->wire->execute($sql, $values),
                };
                $connection->lastError = '';
                return new PgSql\Result($result['fields'], $result['rows'], $result['affected'], $result['command']);
            } catch (Exception $exception) {
                $connection->lastError = $exception->errorInfo[2];
                trigger_error($function . '(): Query failed: ' . $exception->errorInfo[2], E_USER_WARNING);
                return false;
            }
        }

        public static function prepare(PgSql\Connection $connection, string $name, string $sql): PgSql\Result|false
        {
            try {
                $result = $connection->wire->prepare($name, $sql);
                $connection->lastError = '';
                return new PgSql\Result([], [], 0, $result['command']);
            } catch (Exception $exception) {
                $connection->lastError = $exception->errorInfo[2];
                trigger_error('pg_prepare(): Query failed: ' . $exception->errorInfo[2], E_USER_WARNING);
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

        public static function column(PgSql\Result $result, int|string $field): int|false
        {
            return is_int($field) ? (isset($result->fields[$field]) ? $field : false) : array_search($field, array_column($result->fields, 'name'), true);
        }

        public static function typeName(int $oid): string
        {
            return self::TYPES[$oid] ?? 'unknown';
        }

        public static function quote(string $value, string $quote): string
        {
            return $quote . str_replace($quote, $quote . $quote, $value) . $quote;
        }

        /** The last of up to two leading arguments, and the connection (the default one when only one was given). */
        public static function split(string $function, mixed $first, mixed $second): array
        {
            return $second === null ? [self::of(null, $function), $first] : [self::of($first, $function), $second];
        }
    }
}

namespace {
    use Bfwc\Pgsql\Pg;

    const PGSQL_ASSOC = 1;
    const PGSQL_NUM = 2;
    const PGSQL_BOTH = 3;
    const PGSQL_CONNECT_FORCE_NEW = 2;
    const PGSQL_CONNECT_ASYNC = 4;
    const PGSQL_CONNECTION_OK = 0;
    const PGSQL_CONNECTION_BAD = 1;
    const PGSQL_CONNECTION_STARTED = 2;
    const PGSQL_CONNECTION_MADE = 3;
    const PGSQL_CONNECTION_AWAITING_RESPONSE = 4;
    const PGSQL_CONNECTION_AUTH_OK = 5;
    const PGSQL_CONNECTION_SETENV = 6;
    const PGSQL_TRANSACTION_IDLE = 0;
    const PGSQL_TRANSACTION_ACTIVE = 1;
    const PGSQL_TRANSACTION_INTRANS = 2;
    const PGSQL_TRANSACTION_INERROR = 3;
    const PGSQL_TRANSACTION_UNKNOWN = 4;
    const PGSQL_EMPTY_QUERY = 0;
    const PGSQL_COMMAND_OK = 1;
    const PGSQL_TUPLES_OK = 2;
    const PGSQL_COPY_OUT = 3;
    const PGSQL_COPY_IN = 4;
    const PGSQL_BAD_RESPONSE = 5;
    const PGSQL_NONFATAL_ERROR = 6;
    const PGSQL_FATAL_ERROR = 7;
    const PGSQL_STATUS_LONG = 1;
    const PGSQL_STATUS_STRING = 2;
    const PGSQL_SEEK_SET = 0;
    const PGSQL_SEEK_CUR = 1;
    const PGSQL_SEEK_END = 2;
    const PGSQL_ERRORS_TERSE = 0;
    const PGSQL_ERRORS_DEFAULT = 1;
    const PGSQL_ERRORS_VERBOSE = 2;
    const PGSQL_DIAG_SEVERITY = 83;
    const PGSQL_DIAG_SQLSTATE = 67;
    const PGSQL_DIAG_MESSAGE_PRIMARY = 77;
    const PGSQL_DIAG_MESSAGE_DETAIL = 68;
    const PGSQL_DIAG_MESSAGE_HINT = 72;
    const PGSQL_CONV_IGNORE_DEFAULT = 2;
    const PGSQL_CONV_FORCE_NULL = 4;
    const PGSQL_CONV_IGNORE_NOT_NULL = 8;
    const PGSQL_DML_NO_CONV = 256;
    const PGSQL_DML_EXEC = 512;
    const PGSQL_DML_ASYNC = 1024;
    const PGSQL_DML_STRING = 2048;
    const PGSQL_DML_ESCAPE = 4096;

    function pg_connect(string $connection_string, int $flags = 0): PgSql\Connection|false { return Pg::connect($connection_string, $flags); }
    function pg_pconnect(string $connection_string, int $flags = 0): PgSql\Connection|false { return Pg::connect($connection_string, $flags); }
    function pg_close(?PgSql\Connection $connection = null): bool
    {
        $connection = Pg::of($connection, 'pg_close');
        $connection->wire->close();
        $connection->wire = null;
        unset(Pg::$open[$connection->conninfo]);
        if (Pg::$last === $connection) {
            Pg::$last = null;
        }
        return true;
    }
    function pg_query($connection, ?string $query = null): PgSql\Result|false { [$connection, $query] = Pg::split('pg_query', $connection, $query); return Pg::run($connection, 'pg_query', $query, null); }
    function pg_query_params($connection, $query, ?array $params = null): PgSql\Result|false
    {
        [$connection, $query, $params] = $params === null ? [Pg::of(null, 'pg_query_params'), $connection, $query] : [Pg::of($connection, 'pg_query_params'), $query, $params];
        return Pg::run($connection, 'pg_query_params', $query, $params);
    }
    function pg_prepare($connection, string $name, ?string $query = null): PgSql\Result|false
    {
        [$connection, $name, $query] = $query === null ? [Pg::of(null, 'pg_prepare'), $connection, $name] : [Pg::of($connection, 'pg_prepare'), $name, $query];
        return Pg::prepare($connection, $name, $query);
    }
    function pg_execute($connection, $name, ?array $params = null): PgSql\Result|false
    {
        [$connection, $name, $params] = $params === null ? [Pg::of(null, 'pg_execute'), $connection, $name] : [Pg::of($connection, 'pg_execute'), $name, $params];
        return Pg::run($connection, 'pg_execute', $name, $params, true);
    }
    function pg_fetch_assoc(PgSql\Result $result, ?int $row = null): array|false { return Pg::row($result, $row, PGSQL_ASSOC); }
    function pg_fetch_row(PgSql\Result $result, ?int $row = null, int $mode = PGSQL_NUM): array|false { return Pg::row($result, $row, $mode); }
    function pg_fetch_array(PgSql\Result $result, ?int $row = null, int $mode = PGSQL_BOTH): array|false { return Pg::row($result, $row, $mode); }
    function pg_fetch_object(PgSql\Result $result, ?int $row = null, string $class = 'stdClass', array $constructor_args = []): object|false
    {
        $values = Pg::row($result, $row, PGSQL_ASSOC);
        if ($values === false || $class === 'stdClass') {
            return $values === false ? false : (object) $values;
        }
        return Bfwc\Pgsql\Statement::instance($class, $constructor_args, $values, false);
    }
    function pg_fetch_all(PgSql\Result $result, int $mode = PGSQL_ASSOC): array { return array_map(static fn (int $index) => Pg::row($result, $index, $mode), array_keys($result->rows)); }
    function pg_fetch_all_columns(PgSql\Result $result, int $field = 0): array { return array_column($result->rows, $field); }
    function pg_fetch_result(PgSql\Result $result, $row, $field = null): string|false|null
    {
        if ($field === null) {
            [$row, $field] = [$result->cursor++, $row]; // two arguments: the next row
        }
        $column = Pg::column($result, $field);
        return $column === false || !isset($result->rows[$row]) ? false : $result->rows[$row][$column];
    }
    function pg_num_rows(PgSql\Result $result): int { return count($result->rows); }
    function pg_num_fields(PgSql\Result $result): int { return count($result->fields); }
    function pg_field_name(PgSql\Result $result, int $field): string { return $result->fields[$field]['name']; }
    function pg_field_num(PgSql\Result $result, string $field): int { $at = Pg::column($result, $field); return $at === false ? -1 : $at; }
    function pg_field_type(PgSql\Result $result, int $field): string { return Pg::typeName($result->fields[$field]['type']); }
    function pg_field_type_oid(PgSql\Result $result, int $field): string|int { return $result->fields[$field]['type']; }
    function pg_affected_rows(PgSql\Result $result): int { return $result->affected; }
    function pg_free_result(PgSql\Result $result): bool { $result->rows = []; return true; }
    function pg_result_seek(PgSql\Result $result, int $row): bool { if (!isset($result->rows[$row])) return false; $result->cursor = $row; return true; }
    function pg_result_error(PgSql\Result $result): string|false { return ''; }
    function pg_result_status(PgSql\Result $result, int $mode = PGSQL_STATUS_LONG): string|int
    {
        if ($mode === PGSQL_STATUS_STRING) {
            return $result->command;
        }
        return $result->fields !== [] ? PGSQL_TUPLES_OK : PGSQL_COMMAND_OK;
    }
    function pg_last_oid(PgSql\Result $result): string|int|false
    {
        $tag = explode(' ', $result->command);
        return $tag[0] === 'INSERT' && isset($tag[1]) ? (int) $tag[1] : false;
    }
    function pg_last_error(?PgSql\Connection $connection = null): string { return Pg::of($connection, 'pg_last_error')->lastError; }
    function pg_dbname(?PgSql\Connection $connection = null): string { return Pg::of($connection, 'pg_dbname')->wire->database; }
    function pg_escape_string($connection, ?string $string = null): string { return str_replace("'", "''", Pg::split('pg_escape_string', $connection, $string)[1]); }
    function pg_escape_literal($connection, ?string $string = null): string|false { return Pg::quote(Pg::split('pg_escape_literal', $connection, $string)[1], "'"); }
    function pg_escape_identifier($connection, ?string $string = null): string|false { return Pg::quote(Pg::split('pg_escape_identifier', $connection, $string)[1], '"'); }
    function pg_escape_bytea($connection, ?string $string = null): string { return '\\x' . bin2hex(Pg::split('pg_escape_bytea', $connection, $string)[1]); }
    function pg_unescape_bytea(string $string): string
    {
        if (str_starts_with($string, '\\x')) {
            return (string) hex2bin(substr($string, 2));
        }
        return preg_replace_callback('/\\\\([0-7]{3}|\\\\)/', static fn (array $m) => $m[1] === '\\' ? '\\' : chr(octdec($m[1])), $string); // the escape format
    }
    function pg_set_client_encoding($connection, ?string $encoding = null): int
    {
        [$connection, $encoding] = Pg::split('pg_set_client_encoding', $connection, $encoding);
        return @Pg::run($connection, 'pg_set_client_encoding', 'SET client_encoding TO ' . Pg::quote($encoding, "'"), null) === false ? -1 : 0;
    }
    function pg_client_encoding(?PgSql\Connection $connection = null): string { return Pg::of($connection, 'pg_client_encoding')->wire->parameters['client_encoding'] ?? 'UTF8'; }
    function pg_connection_status(PgSql\Connection $connection): int { return $connection->wire ? PGSQL_CONNECTION_OK : PGSQL_CONNECTION_BAD; }
    function pg_transaction_status(PgSql\Connection $connection): int
    {
        return match ($connection->wire?->status) { 'I' => PGSQL_TRANSACTION_IDLE, 'T' => PGSQL_TRANSACTION_INTRANS, 'E' => PGSQL_TRANSACTION_INERROR, default => PGSQL_TRANSACTION_UNKNOWN };
    }
    function pg_parameter_status($connection, ?string $name = null): string|false
    {
        [$connection, $name] = Pg::split('pg_parameter_status', $connection, $name);
        return $connection->wire->parameters[$name] ?? false;
    }
    function pg_version(?PgSql\Connection $connection = null): array
    {
        return ['client' => 'bfwc-pgsql', 'protocol' => 3, 'server' => Pg::of($connection, 'pg_version')->wire->parameters['server_version'] ?? ''];
    }
    function pg_ping(?PgSql\Connection $connection = null): bool { return Pg::of($connection, 'pg_ping')->wire !== null; }
}
`;
