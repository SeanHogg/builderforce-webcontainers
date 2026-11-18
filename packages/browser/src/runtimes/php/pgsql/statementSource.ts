/**
 * `Bfwc\Pgsql\Statement`: the `\PDOStatement` of the runtime's PDO
 * (pdoSource.ts): placeholders rewritten to `$n`, values bound as text,
 * results typed as pdo_pgsql types them, and the fetch modes. Loaded on first
 * use.
 */
export const STATEMENT_SOURCE = String.raw`<?php
namespace Bfwc\Pgsql;

class Statement extends \PDOStatement
{
    private string $sql;
    /** @var list<int|string> placeholder keys, in $n order */
    private array $keys;
    private array $bound = [];
    private array $fields = [];
    private array $rows = [];
    private int $affected = 0;
    private array $fetchArgs = [];
    private array $error = ['00000', null, null];

    public function __construct(private PDO $pdo, string $query, private int $fetchMode, private bool $stringify)
    {
        $this->queryString = $query;
        [$this->sql, $this->keys] = self::placeholders($query);
    }

    /** Whether $char continues an identifier (so a $ or E' there does not start a quote). */
    private static function identifierChar(string $char): bool
    {
        return $char !== '' && (ctype_alnum($char) || $char === '_' || $char === '$' || ord($char) >= 0x80);
    }

    private static function invalidParameters(string $why): Exception
    {
        return Exception::fromState('HY093', 'Invalid parameter number: ' . $why);
    }

    /**
     * ? and :name as $1…, outside quotes ('…', E'…' at a token boundary, "…"),
     * comments (-- to the line end; nested block comments), dollar quotes ($tag$…$tag$, not inside an
     * identifier) and :: casts; ?? is a literal ?. Mixing named and positional
     * placeholders is refused, as PDO does.
     */
    public static function placeholders(string $sql): array
    {
        $out = '';
        $keys = [];
        $named = [];
        $positional = false;
        $length = strlen($sql);
        for ($i = 0; $i < $length; $i++) {
            $char = $sql[$i];
            $next = $sql[$i + 1] ?? '';
            $previous = $i > 0 ? $sql[$i - 1] : '';
            if ($char === "'" || $char === '"') {
                $end = $i + 1;
                $escapes = $char === "'" && ($previous === 'E' || $previous === 'e') && !self::identifierChar($i > 1 ? $sql[$i - 2] : '');
                while ($end < $length && ($sql[$end] !== $char || ($sql[$end + 1] ?? '') === $char)) {
                    $end += ($sql[$end] === $char || ($escapes && $sql[$end] === '\')) ? 2 : 1;
                }
                $out .= substr($sql, $i, $end - $i + 1);
                $i = $end;
            } elseif ($char === '-' && $next === '-') {
                $end = strpos($sql, "\n", $i);
                $end = $end === false ? $length : $end;
                $out .= substr($sql, $i, $end - $i);
                $i = $end - 1;
            } elseif ($char === '/' && $next === '*') {
                $depth = 0;
                for ($end = $i; $end < $length; $end++) {
                    if ($sql[$end] === '/' && ($sql[$end + 1] ?? '') === '*') {
                        $depth++;
                        $end++;
                    } elseif ($sql[$end] === '*' && ($sql[$end + 1] ?? '') === '/') {
                        $depth--;
                        $end++;
                        if ($depth === 0) {
                            break;
                        }
                    }
                }
                $end = min($end + 1, $length);
                $out .= substr($sql, $i, $end - $i);
                $i = $end - 1;
            } elseif ($char === '$' && !self::identifierChar($previous) && preg_match('/\G\$([A-Za-z_][A-Za-z0-9_]*)?\$/', $sql, $tag, 0, $i)) {
                $end = strpos($sql, $tag[0], $i + strlen($tag[0]));
                $end = $end === false ? $length : $end + strlen($tag[0]);
                $out .= substr($sql, $i, $end - $i);
                $i = $end - 1;
            } elseif ($char === ':' && $next === ':') {
                $out .= '::';
                $i++;
            } elseif ($char === ':' && preg_match('/\G:([A-Za-z_][A-Za-z0-9_]*)/', $sql, $name, 0, $i)) {
                if ($positional) {
                    throw self::invalidParameters('mixed named and positional parameters');
                }
                $named[$name[1]] ??= count($keys) + 1;
                if ($named[$name[1]] === count($keys) + 1) {
                    $keys[] = $name[1];
                }
                $out .= '$' . $named[$name[1]];
                $i += strlen($name[0]) - 1;
            } elseif ($char === '?' && $next === '?') {
                $out .= '?';
                $i++;
            } elseif ($char === '?') {
                if ($named) {
                    throw self::invalidParameters('mixed named and positional parameters');
                }
                $positional = true;
                $keys[] = count($keys);
                $out .= '$' . count($keys);
            } else {
                $out .= $char;
            }
        }
        return [$out, $keys];
    }

    private static function text(mixed $value, int $type): ?string
    {
        if ($value === null || $type === \PDO::PARAM_NULL) {
            return null;
        }
        if (is_resource($value)) {
            return stream_get_contents($value);
        }
        if (is_bool($value) || $type === \PDO::PARAM_BOOL) {
            return $value ? 't' : 'f';
        }
        return (string) $value;
    }

    public function bindValue(int|string $param, mixed $value, int $type = \PDO::PARAM_STR): bool
    {
        $this->bound[is_int($param) ? $param - 1 : ltrim($param, ':')] = [$value, $type];
        return true;
    }

    public function bindParam(int|string $param, mixed &$var, int $type = \PDO::PARAM_STR, int $maxLength = 0, mixed $driverOptions = null): bool
    {
        $this->bound[is_int($param) ? $param - 1 : ltrim($param, ':')] = [&$var, $type];
        return true;
    }

    /** @internal */
    public function bfwcFailed(array $errorInfo): void
    {
        $this->error = $errorInfo;
    }

    public function execute(?array $params = null): bool
    {
        $values = [];
        if ($params !== null && count($params) !== count($this->keys)) {
            throw self::invalidParameters('number of bound variables does not match number of tokens');
        }
        foreach ($this->keys as $key) {
            if ($params !== null) {
                $name = is_int($key) ? $key : (array_key_exists($key, $params) ? $key : ':' . $key);
                if (!array_key_exists($name, $params)) {
                    throw self::invalidParameters('parameter was not defined');
                }
                $values[] = self::text($params[$name], \PDO::PARAM_STR);
            } else {
                if (!array_key_exists($key, $this->bound)) {
                    throw self::invalidParameters('parameter was not defined');
                }
                [$value, $type] = $this->bound[$key];
                $values[] = self::text($value, $type);
            }
        }
        $result = $this->pdo->bfwcRun($this->sql, $values, $this);
        if ($result === null) {
            return false;
        }
        $this->error = ['00000', null, null];
        $this->fields = $result['fields'];
        $this->rows = $result['rows'];
        $this->affected = $result['affected'];
        return true;
    }

    private function value(?string $text, int $type): mixed
    {
        if ($text === null || $this->stringify) {
            return $text;
        }
        return match ($type) {
            16 => $text === 't',
            // int8 and oid fit PHP's int only on 64-bit; past PHP_INT_MAX (php-wasm is 32-bit) they stay strings, as pdo_pgsql leaves them.
            20, 21, 23, 26 => PHP_INT_SIZE === 8 || (string) (int) $text === ltrim($text, '+') ? (int) $text : $text,
            700, 701 => (float) $text,
            default => $text,
        };
    }

    private function shape(array $row, int $mode, array $args): mixed
    {
        $values = [];
        foreach ($row as $i => $text) {
            $values[$i] = $this->value($text, $this->fields[$i]['type']);
        }
        $names = array_column($this->fields, 'name');
        return match ($mode & ~\PDO::FETCH_PROPS_LATE) {
            \PDO::FETCH_ASSOC => array_combine($names, $values),
            \PDO::FETCH_NUM => $values,
            \PDO::FETCH_BOTH => array_combine($names, $values) + $values,
            \PDO::FETCH_OBJ => (object) array_combine($names, $values),
            \PDO::FETCH_COLUMN => $values[$args[0] ?? 0] ?? null,
            \PDO::FETCH_CLASS => self::instance($args[0] ?? \stdClass::class, $args[1] ?? [], array_combine($names, $values), (bool) ($mode & \PDO::FETCH_PROPS_LATE)),
            default => throw new \PDOException('Fetch mode ' . $mode . ' is not supported by the runtime\'s pgsql client (ASSOC, NUM, BOTH, OBJ, COLUMN, KEY_PAIR, CLASS are)'),
        };
    }

    private static function instance(string $class, array $args, array $properties, bool $late): object
    {
        $object = (new \ReflectionClass($class))->newInstanceWithoutConstructor();
        $assign = function () use ($object, $properties) {
            foreach ($properties as $name => $value) {
                $object->$name = $value;
            }
        };
        if (!$late) {
            \Closure::bind($assign, null, $class)();
        }
        if (method_exists($object, '__construct')) {
            $object->__construct(...$args);
        }
        if ($late) {
            \Closure::bind($assign, null, $class)();
        }
        return $object;
    }

    private function mode(int $mode): int
    {
        return $mode === \PDO::FETCH_DEFAULT ? $this->fetchMode : $mode;
    }

    public function fetch(int $mode = \PDO::FETCH_DEFAULT, int $cursorOrientation = \PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed
    {
        $row = array_shift($this->rows);
        if ($row === null) {
            return false;
        }
        $mode = $this->mode($mode);
        return $mode === \PDO::FETCH_KEY_PAIR ? [$this->value($row[0], $this->fields[0]['type']) => $this->value($row[1], $this->fields[1]['type'])] : $this->shape($row, $mode, $this->fetchArgs);
    }

    public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array
    {
        $mode = $this->mode($mode);
        $args = $args ?: $this->fetchArgs;
        $out = [];
        while (($row = array_shift($this->rows)) !== null) {
            if ($mode === \PDO::FETCH_KEY_PAIR) {
                $out[$this->value($row[0], $this->fields[0]['type'])] = $this->value($row[1], $this->fields[1]['type']);
            } else {
                $out[] = $this->shape($row, $mode, $args);
            }
        }
        return $out;
    }

    public function fetchColumn(int $column = 0): mixed
    {
        $row = array_shift($this->rows);
        return $row === null ? false : $this->value($row[$column] ?? null, $this->fields[$column]['type'] ?? 25);
    }

    public function fetchObject(?string $class = 'stdClass', array $constructorArgs = []): object|false
    {
        $row = array_shift($this->rows);
        return $row === null ? false : $this->shape($row, \PDO::FETCH_CLASS, [$class ?? \stdClass::class, $constructorArgs]);
    }

    public function setFetchMode(int $mode, mixed ...$args): bool
    {
        $this->fetchMode = $mode;
        $this->fetchArgs = $args;
        return true;
    }

    public function rowCount(): int
    {
        return $this->affected;
    }

    public function columnCount(): int
    {
        return count($this->fields);
    }

    public function getColumnMeta(int $column): array|false
    {
        $field = $this->fields[$column] ?? null;
        return $field ? ['name' => $field['name'], 'pgsql:oid' => $field['type'], 'native_type' => (string) $field['type'], 'len' => -1, 'precision' => -1, 'flags' => []] : false;
    }

    public function closeCursor(): bool
    {
        $this->rows = [];
        return true;
    }

    public function errorCode(): ?string
    {
        return $this->error[0];
    }

    public function errorInfo(): array
    {
        return $this->error;
    }

    public function getIterator(): \Iterator
    {
        while (($row = $this->fetch()) !== false) {
            yield $row;
        }
    }
}
`;
