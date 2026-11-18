/**
 * Built-in `new PDO('pgsql:…')` without a `pdo_pgsql` extension. php-wasm has
 * no Postgres driver, and PHP cannot redeclare its built-in `PDO` class (not
 * even with `disable_classes`), so the runtime rewrites the construction
 * instead: `Bfwc\Pgsql\Includes` is the `file://` stream wrapper, a pass-through
 * to the native one except that a PHP file opened for `include`/`require` has
 * each `new PDO(` that names the global `PDO` (`new \PDO(`, `new PDO(` outside a
 * namespace, or after `use PDO;` / `use PDO as Alias;`) rewritten to
 * `\Bfwc\Pgsql\pdo(`. That factory hands `pgsql:` DSNs to `Bfwc\Pgsql\PDO` (a
 * `\PDO`, so `instanceof PDO`, type hints and `PDO::ATTR_*` hold) and every
 * other DSN (sqlite, mysql) to the native `\PDO`.
 *
 * Only files that mention `pdo` are tokenized; line numbers are kept; the
 * runtime's own files (`/bfwc/`) are never rewritten. A script run as `php
 * script.php` is opened by the CLI, not through the wrapper, so when it needs
 * the rewrite the auto-prepended script requires it (rewritten) and exits.
 * Not covered: subclasses (`class Db extends PDO`), PHP 8.4's `PDO::connect()`,
 * and `php -r` code.
 */
export const INCLUDES_SOURCE = String.raw`<?php
namespace Bfwc\Pgsql;

/** What a rewritten 'new PDO(...)' calls: the runtime's PDO for pgsql: DSNs, the native one for the rest. */
function pdo(string $dsn, ?string $username = null, #[\SensitiveParameter] ?string $password = null, ?array $options = null): \PDO
{
    return str_starts_with(ltrim($dsn), 'pgsql:') ? new PDO($dsn, $username, $password, $options) : new \PDO($dsn, $username, $password, $options);
}

final class Includes
{
    private const FOR_INCLUDE = 128; // STREAM_OPEN_FOR_INCLUDE (not exposed to PHP code)
    private const RUNTIME_ROOT = '/bfwc/';
    private const FACTORY = '\\Bfwc\\Pgsql\\pdo';

    /** @var resource|null */
    public $context;
    /** @var resource|null */
    private $handle;
    /** The file a rewritten source came from, and the rewritten size (its stat reports both). */
    private ?string $path = null;
    private ?int $size = null;

    public static function register(): void
    {
        @stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
    }

    /** Run $call on the native file wrapper. */
    private static function native(callable $call, mixed ...$args): mixed
    {
        stream_wrapper_restore('file');
        try {
            return $call(...$args);
        } finally {
            self::register();
        }
    }

    /** Whether the CLI's script needs the rewrite (the prepend then requires it itself). */
    public static function rewritesPrimary(): bool
    {
        $script = $_SERVER['SCRIPT_FILENAME'] ?? '';
        // Under php -S the primary script is the runtime's front script, which requires the target itself.
        if (PHP_SAPI === 'cli-server' || $script === '' || str_starts_with($script, self::RUNTIME_ROOT) || str_starts_with($script, '/internal/') || !is_file($script)) {
            return false;
        }
        $source = (string) file_get_contents($script);
        return !str_contains($source, '__halt_compiler') && self::rewrite($source) !== $source;
    }

    /** $source with each 'new PDO(' naming the global PDO calling the factory instead. */
    public static function rewrite(string $source): string
    {
        if (stripos($source, 'pdo') === false) {
            return $source;
        }
        try {
            $tokens = \PhpToken::tokenize($source);
        } catch (\Throwable) {
            return $source;
        }
        $global = true;
        $aliases = [];
        $out = '';
        $changed = false;
        $count = count($tokens);
        for ($i = 0; $i < $count; $i++) {
            $token = $tokens[$i];
            if ($token->id === T_NAMESPACE) {
                $next = self::significant($tokens, $i + 1);
                $global = $next === null || in_array($tokens[$next]->text, [';', '{'], true);
                $aliases = [];
            } elseif ($token->id === T_USE) {
                $aliases += self::imports($tokens, $i + 1);
            } elseif ($token->id === T_NEW) {
                $name = self::significant($tokens, $i + 1);
                $paren = $name === null ? null : self::significant($tokens, $name + 1);
                if ($paren !== null && $tokens[$paren]->text === '(' && self::isPdo($tokens[$name], $global, $aliases)) {
                    $skipped = '';
                    for ($j = $i; $j < $paren; $j++) {
                        $skipped .= $tokens[$j]->text;
                    }
                    $out .= self::FACTORY . str_repeat("\n", substr_count($skipped, "\n"));
                    $changed = true;
                    $i = $paren - 1;
                    continue;
                }
            }
            $out .= $token->text;
        }
        return $changed ? $out : $source;
    }

    private static function isPdo(\PhpToken $name, bool $global, array $aliases): bool
    {
        $lower = strtolower($name->text);
        return ($name->id === T_NAME_FULLY_QUALIFIED && $lower === '\\pdo') || ($name->id === T_STRING && (isset($aliases[$lower]) || ($global && $lower === 'pdo')));
    }

    /** The index of the next token that is not whitespace or a comment. */
    private static function significant(array $tokens, int $from): ?int
    {
        for ($i = $from, $n = count($tokens); $i < $n; $i++) {
            if (!$tokens[$i]->is([T_WHITESPACE, T_COMMENT, T_DOC_COMMENT])) {
                return $i;
            }
        }
        return null;
    }

    /** The aliases a 'use' statement gives the global PDO ([] for closures, functions, constants, other classes). */
    private static function imports(array $tokens, int $from): array
    {
        $aliases = [];
        $name = null;
        $alias = null;
        $expectAlias = false;
        for ($i = $from, $n = count($tokens); $i < $n; $i++) {
            $token = $tokens[$i];
            if ($token->is([T_WHITESPACE, T_COMMENT, T_DOC_COMMENT])) {
                continue;
            }
            if (in_array($token->text, ['(', '{'], true) || ($name === null && in_array(strtolower($token->text), ['function', 'const'], true))) {
                return [];
            }
            if ($token->id === T_AS) {
                $expectAlias = true;
            } elseif ($token->text === ',' || $token->text === ';') {
                if ($name !== null && strtolower(ltrim($name, '\\')) === 'pdo') {
                    $aliases[strtolower($alias ?? 'PDO')] = true;
                }
                $name = $alias = null;
                $expectAlias = false;
                if ($token->text === ';') {
                    return $aliases;
                }
            } elseif ($expectAlias) {
                $alias = $token->text;
            } else {
                $name = $token->text;
            }
        }
        return $aliases;
    }

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        $quiet = !($options & STREAM_REPORT_ERRORS);
        $handle = self::native(fn () => $quiet ? @fopen($path, $mode, (bool) ($options & STREAM_USE_PATH), $this->context) : fopen($path, $mode, (bool) ($options & STREAM_USE_PATH), $this->context));
        if (!$handle) {
            return false;
        }
        $this->handle = $handle;
        if ($options & self::FOR_INCLUDE && !str_starts_with($path, self::RUNTIME_ROOT)) {
            $source = (string) stream_get_contents($handle);
            $rewritten = self::rewrite($source);
            if ($rewritten === $source) {
                rewind($handle);
            } else {
                fclose($handle);
                $this->handle = fopen('php://memory', 'w+b');
                fwrite($this->handle, $rewritten);
                rewind($this->handle);
                $this->path = $path;
                $this->size = strlen($rewritten);
            }
        }
        return true;
    }

    public function stream_read(int $count): string|false
    {
        return fread($this->handle, $count);
    }

    public function stream_write(string $data): int|false
    {
        return fwrite($this->handle, $data);
    }

    public function stream_eof(): bool
    {
        return feof($this->handle);
    }

    public function stream_tell(): int|false
    {
        return ftell($this->handle);
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        return fseek($this->handle, $offset, $whence) === 0;
    }

    public function stream_flush(): bool
    {
        return fflush($this->handle);
    }

    public function stream_close(): void
    {
        if (is_resource($this->handle)) {
            fclose($this->handle);
        }
    }

    public function stream_stat(): array|false
    {
        if ($this->path === null) {
            return fstat($this->handle);
        }
        // The file's own stat (its mtime keeps cached compilations honest), with the rewritten size.
        $stat = self::native(fn () => @stat($this->path)) ?: fstat($this->handle);
        $stat[7] = $stat['size'] = $this->size;
        return $stat;
    }

    public function stream_lock(int $operation): bool
    {
        return $operation === 0 ? true : flock($this->handle, $operation);
    }

    public function stream_truncate(int $size): bool
    {
        return ftruncate($this->handle, $size);
    }

    public function stream_set_option(int $option, int $arg1, ?int $arg2): bool
    {
        return match ($option) {
            STREAM_OPTION_BLOCKING => stream_set_blocking($this->handle, (bool) $arg1),
            STREAM_OPTION_READ_TIMEOUT => stream_set_timeout($this->handle, $arg1, (int) $arg2),
            STREAM_OPTION_WRITE_BUFFER => stream_set_write_buffer($this->handle, (int) $arg2) === 0,
            default => false,
        };
    }

    /** @return resource */
    public function stream_cast(int $castAs)
    {
        return $this->handle;
    }

    public function stream_metadata(string $path, int $option, mixed $value): bool
    {
        return self::native(fn () => match ($option) {
            STREAM_META_TOUCH => touch($path, ...array_values((array) $value)),
            STREAM_META_OWNER_NAME, STREAM_META_OWNER => chown($path, $value),
            STREAM_META_GROUP_NAME, STREAM_META_GROUP => chgrp($path, $value),
            STREAM_META_ACCESS => chmod($path, $value),
            default => false,
        });
    }

    public function url_stat(string $path, int $flags): array|false
    {
        $stat = $flags & STREAM_URL_STAT_LINK ? 'lstat' : 'stat';
        return self::native(fn () => $flags & STREAM_URL_STAT_QUIET ? @$stat($path) : $stat($path));
    }

    public function unlink(string $path): bool
    {
        return self::native(fn () => unlink($path, $this->context));
    }

    public function rename(string $from, string $to): bool
    {
        return self::native(fn () => rename($from, $to, $this->context));
    }

    public function mkdir(string $path, int $mode, int $options): bool
    {
        return self::native(fn () => mkdir($path, $mode, (bool) ($options & STREAM_MKDIR_RECURSIVE), $this->context));
    }

    public function rmdir(string $path, int $options): bool
    {
        return self::native(fn () => rmdir($path, $this->context));
    }

    public function dir_opendir(string $path, int $options): bool
    {
        $this->handle = self::native(fn () => opendir($path, $this->context));
        return (bool) $this->handle;
    }

    public function dir_readdir(): string|false
    {
        return readdir($this->handle);
    }

    public function dir_rewinddir(): bool
    {
        rewinddir($this->handle);
        return true;
    }

    public function dir_closedir(): bool
    {
        closedir($this->handle);
        return true;
    }
}
`;
