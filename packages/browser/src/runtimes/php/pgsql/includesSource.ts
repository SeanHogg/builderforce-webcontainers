/**
 * Built-in `new PDO('pgsql:…')` without a `pdo_pgsql` extension. php-wasm has
 * no Postgres driver, and PHP cannot redeclare its built-in `PDO` class (not
 * even with `disable_classes`), so the runtime rewrites the construction:
 * `Bfwc\Pgsql\Includes` is the `file://` stream wrapper, a pass-through to the
 * native one except that a file opened for `include`/`require` is served
 * through `Bfwc\Pgsql\Rewriter` (rewriterSource.ts). The rewritten calls land
 * on `pdo()` / `connect()` here, which hand pgsql: DSNs (aliases and `uri:`
 * resolved as PDO resolves them) to `Bfwc\Pgsql\PDO` — a `\PDO`, so `instanceof
 * PDO`, type hints and `PDO::ATTR_*` hold — and every other DSN to the native
 * PDO.
 *
 * Cost: an included file is read once; only files matching
 * `Includes::CANDIDATE` are tokenized, and their result is cached on disk
 * (outside the project) by path, mtime and size, so later `php -S` requests in
 * the same PHP reuse it. A stat reports the file's own mtime (cached
 * compilations stay honest) with the rewritten size.
 *
 * A script run as `php script.php` is opened by the CLI, not through the
 * wrapper, so when it needs the rewrite the auto-prepended script requires it
 * (rewritten) and exits. Not covered: subclasses (`class Db extends PDO`),
 * constant-expression contexts (see rewriterSource.ts), `php -r` code. Another
 * library that replaces the `file` wrapper itself (dg/bypass-finals and the
 * like) displaces this one while it is registered, and the native wrapper it
 * restores ends the rewrite for that request. A failed native call's warning
 * keeps PHP's own text and path, raised again as E_USER_WARNING (PHP code
 * cannot raise E_WARNING), followed by PHP's own "stream_open call failed".
 */
export const INCLUDES_SOURCE = String.raw`<?php
namespace Bfwc\Pgsql;

/** What a rewritten 'new PDO(...)' calls: the runtime's PDO for pgsql: DSNs, the native one for the rest. */
function pdo(string $dsn, ?string $username = null, #[\SensitiveParameter] ?string $password = null, ?array $options = null): \PDO
{
    return PDO::pgsqlDsn($dsn) !== null ? new PDO($dsn, $username, $password, $options) : new \PDO($dsn, $username, $password, $options);
}

/** What a rewritten 'PDO::connect(...)' (PHP 8.4) calls. */
function connect(string $dsn, ?string $username = null, #[\SensitiveParameter] ?string $password = null, ?array $options = null): \PDO
{
    if (PDO::pgsqlDsn($dsn) !== null) {
        return new PDO($dsn, $username, $password, $options);
    }
    return method_exists(\PDO::class, 'connect') ? \PDO::connect($dsn, $username, $password, $options) : new \PDO($dsn, $username, $password, $options);
}

final class Includes
{
    /** Cheap test for a file that might need the rewrite: a construction, PDO::connect, or an import that could alias PDO. */
    public const CANDIDATE = '/new\s*\\\\?pdo\s*\(|pdo\s*::\s*connect\s*\(|\buse\s+\\\\?pdo\b/i';

    private const FOR_INCLUDE = 128; // STREAM_OPEN_FOR_INCLUDE (not exposed to PHP code)
    private const RUNTIME_ROOT = '/bfwc/';
    private const CACHE = '/bfwc/cache';

    /** @var resource|null */
    public $context;
    /** @var resource|null a native file or directory handle */
    private $handle;
    /** An included file's (rewritten) source, served from memory, and the file's stat. */
    private ?string $source = null;
    private int $position = 0;
    private array $stat = [];
    /** @var array<string, array{source: string, stat: array, changed: bool}> loaded sources this request */
    private static array $loaded = [];

    public static function register(): void
    {
        @stream_wrapper_unregister('file');
        stream_wrapper_register('file', self::class);
    }

    /**
     * Run $call on the native file wrapper (one restore and one re-register per
     * operation). PHP never passes STREAM_REPORT_ERRORS to a userland wrapper,
     * so a failure's native warning (its own text and path) is raised again
     * here unless $quiet; a caller's @ still silences it.
     */
    private static function native(callable $call, bool $quiet = false): mixed
    {
        stream_wrapper_restore('file');
        error_clear_last();
        try {
            $result = @$call();
        } finally {
            self::register();
        }
        $error = error_get_last();
        if (($result === false || $result === null) && !$quiet && $error !== null) {
            trigger_error($error['message'], E_USER_WARNING);
        }
        return $result;
    }

    /** Whether the CLI's script needs the rewrite (the prepend then requires it itself). */
    public static function rewritesPrimary(): bool
    {
        $script = $_SERVER['SCRIPT_FILENAME'] ?? '';
        // Under php -S the primary script is the runtime's front script, which requires the target itself.
        if (PHP_SAPI === 'cli-server' || $script === '' || str_starts_with($script, self::RUNTIME_ROOT) || str_starts_with($script, '/internal/')) {
            return false;
        }
        return (bool) self::native(static fn () => self::load($script)['changed'] ?? false, true);
    }

    /**
     * $path's source, rewritten where needed, and its stat; null when it cannot
     * be read. Native wrapper only.
     */
    private static function load(string $path): ?array
    {
        $source = file_get_contents($path);
        if ($source === false) {
            return null;
        }
        $stat = @stat($path) ?: [];
        $key = $path . "\0" . ($stat['mtime'] ?? 0) . "\0" . strlen($source);
        if (isset(self::$loaded[$key])) {
            return self::$loaded[$key];
        }
        $rewritten = $source;
        if (!str_starts_with($path, self::RUNTIME_ROOT) && preg_match(self::CANDIDATE, $source)) {
            $cached = self::CACHE . '/' . md5($key) . '.php';
            $hit = @file_get_contents($cached);
            if ($hit === false) {
                $rewritten = Rewriter::rewrite($source);
                @mkdir(self::CACHE, 0777, true);
                @file_put_contents($cached, $rewritten);
            } else {
                $rewritten = $hit;
            }
        }
        return self::$loaded[$key] = ['source' => $rewritten, 'stat' => $stat, 'changed' => $rewritten !== $source];
    }

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        if ($options & self::FOR_INCLUDE) {
            $loaded = self::native(static fn () => self::load($path));
            if ($loaded === null) {
                return false;
            }
            $this->source = $loaded['source'];
            $this->stat = $loaded['stat'];
            $this->stat[7] = $this->stat['size'] = strlen($this->source);
        } else {
            $usePath = (bool) ($options & STREAM_USE_PATH);
            $this->handle = self::native(fn () => fopen($path, $mode, $usePath, $this->context));
            if (!$this->handle) {
                return false;
            }
        }
        $openedPath = $path;
        return true;
    }

    public function stream_read(int $count): string|false
    {
        if ($this->source === null) {
            return fread($this->handle, $count);
        }
        $chunk = substr($this->source, $this->position, $count);
        $this->position += strlen($chunk);
        return $chunk;
    }

    public function stream_write(string $data): int|false
    {
        return $this->source === null ? fwrite($this->handle, $data) : false;
    }

    public function stream_eof(): bool
    {
        return $this->source === null ? feof($this->handle) : $this->position >= strlen($this->source);
    }

    public function stream_tell(): int|false
    {
        return $this->source === null ? ftell($this->handle) : $this->position;
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        if ($this->source === null) {
            return fseek($this->handle, $offset, $whence) === 0;
        }
        $target = match ($whence) { SEEK_CUR => $this->position + $offset, SEEK_END => strlen($this->source) + $offset, default => $offset };
        if ($target < 0) {
            return false;
        }
        $this->position = $target;
        return true;
    }

    public function stream_flush(): bool
    {
        return $this->source === null ? fflush($this->handle) : true;
    }

    public function stream_close(): void
    {
        if (is_resource($this->handle)) {
            fclose($this->handle);
        }
    }

    public function stream_stat(): array|false
    {
        return $this->source === null ? fstat($this->handle) : $this->stat;
    }

    public function stream_lock(int $operation): bool
    {
        return $this->source !== null || $operation === 0 ? true : flock($this->handle, $operation);
    }

    public function stream_truncate(int $size): bool
    {
        return $this->source === null && ftruncate($this->handle, $size);
    }

    public function stream_set_option(int $option, int $arg1, ?int $arg2): bool
    {
        if ($this->source !== null) {
            return false;
        }
        return match ($option) {
            STREAM_OPTION_BLOCKING => stream_set_blocking($this->handle, (bool) $arg1),
            STREAM_OPTION_READ_TIMEOUT => stream_set_timeout($this->handle, $arg1, (int) $arg2),
            STREAM_OPTION_WRITE_BUFFER => stream_set_write_buffer($this->handle, (int) $arg2) === 0,
            default => false,
        };
    }

    /** @return resource|false */
    public function stream_cast(int $castAs)
    {
        return $this->handle ?? false;
    }

    public function stream_metadata(string $path, int $option, mixed $value): bool
    {
        return self::native(static fn () => match ($option) {
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
        return self::native(static fn () => $stat($path), (bool) ($flags & STREAM_URL_STAT_QUIET));
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
