/**
 * Running what a PHP command line asked for (`parsePhpCommand`) in a started
 * PHP: PHP's own CLI on the arguments (to its exit code), `php -S` served
 * request-driven (phpWebServer.ts), or Composer (composer/composerInstall.ts).
 */
import { bytesToBase64, dirname, join, resolveFrom } from '@seanhogg/builderforce-webcontainers-core';
import type { ComposerFiles } from './composer/autoload.js';
import { runComposer } from './composer/composerInstall.js';
import { createPackageSource } from './composer/packagist.js';
import type { PhpInvocation } from './phpCommand.js';
import type { LoadedPhp } from './phpLoader.js';
import type { WrappableEmscriptenFs } from '../emscripten/wrappedFsWrites.js';
import type { ComposerSourceOptions } from './phpStartOptions.js';
import { drainBytes, drainText } from './phpStreams.js';
import { childrenOf, isDirectory, isFile, removeTree } from '../emscripten/projectMirror.js';
import type { InterpreterOutcome } from '../interpreterProcess.js';
import type { Platform } from './composer/platform.js';
import { startPhpWebServer } from './phpWebServer.js';

export interface PhpProgramContext {
  /** The working directory, a PHP path. */
  cwd: string;
  env: Readonly<Record<string, string>>;
  io: { stdout(data: string | Uint8Array): unknown; stderr(data: string | Uint8Array): unknown };
  composer?: ComposerSourceOptions;
  fetch?: typeof fetch;
  /** The running PHP's version and extensions, once read (the page caches them for the `php` provider). */
  platformKnown?(platform: Platform): void;
}

const isDir = isDirectory;

/** The installer's file calls on php-wasm's FS (its writes are tracked like PHP's own). */
export function composerFiles(FS: WrappableEmscriptenFs): ComposerFiles {
  const list = (dir: string): string[] => childrenOf(FS, dir).flatMap((name) => (isDir(FS, join(dir, name)) ? list(join(dir, name)) : [join(dir, name)]));
  const remove = (path: string) => removeTree(FS, path);
  return {
    read: (path) => (isFile(FS, path) ? new TextDecoder().decode(FS.readFile(path)) : undefined),
    write(path, content) {
      FS.mkdirTree(dirname(path));
      FS.writeFile(path, content);
    },
    isDir: (path) => isDir(FS, path),
    list: (dir) => (isDir(FS, dir) ? list(dir) : []),
    remove,
  };
}

/** One buffered PHP run's output (platform facts, the lock's content hash). */
async function evaluate(loaded: LoadedPhp, code: string): Promise<string> {
  const result = await loaded.php.run({ code });
  if (result.exitCode !== 0) throw new Error(`PHP failed: ${result.errors || result.text}`);
  return result.text;
}

/** Composer's lock `content-hash`: md5 of the relevant composer.json keys, sorted, as `json_encode` writes them. */
const CONTENT_HASH = (json: string) => `<?php
$c = json_decode(base64_decode('${bytesToBase64(new TextEncoder().encode(json))}'), true) ?: [];
$keys = ['name', 'version', 'require', 'require-dev', 'conflict', 'replace', 'provide', 'minimum-stability', 'prefer-stable', 'repositories', 'extra'];
$r = array_intersect_key($c, array_flip($keys));
if (isset($c['config']['platform'])) { $r['config']['platform'] = $c['config']['platform']; }
ksort($r);
echo md5(json_encode($r));`;

/** The running PHP's version and loaded extensions (lower-case), reported to the page. */
async function platformOf(loaded: LoadedPhp, context: PhpProgramContext): Promise<Platform> {
  const [phpVersion, extensions] = JSON.parse(await evaluate(loaded, '<?php echo json_encode([PHP_VERSION, array_map("strtolower", get_loaded_extensions())]);')) as [string, string[]];
  const platform = { phpVersion, extensions: new Set(extensions) };
  context.platformKnown?.(platform);
  return platform;
}

async function composer(loaded: LoadedPhp, invocation: Extract<PhpInvocation, { kind: 'composer' }>, context: PhpProgramContext): Promise<number> {
  const platform = await platformOf(loaded, context);
  const projectDir = invocation.workingDir ? resolveFrom(context.cwd, invocation.workingDir) : context.cwd;
  return runComposer(invocation, {
    files: composerFiles(loaded.module.FS),
    source: createPackageSource({ ...context.composer, fetch: context.fetch }),
    platform,
    projectDir,
    contentHash: (json) => evaluate(loaded, CONTENT_HASH(json)),
    out: (line) => context.io.stdout(line),
    err: (line) => context.io.stderr(line),
  });
}

/** Run `invocation` (its paths already PHP paths). */
export async function runPhpInvocation(loaded: LoadedPhp, invocation: PhpInvocation, context: PhpProgramContext): Promise<InterpreterOutcome> {
  const { php, module } = loaded;
  if (invocation.kind === 'composer') return { kind: 'exited', code: await composer(loaded, invocation, context) };
  if (invocation.kind === 'serve') {
    // `PHP_SAPI === 'cli-server'`, as under `php -S`; settable only before PHP's first run.
    await php.setSapiName('cli-server');
    const version = (await platformOf(loaded, context)).phpVersion;
    const docroot = invocation.server.docroot ? resolveFrom(context.cwd, invocation.server.docroot) : context.cwd;
    if (!isDir(module.FS, docroot)) {
      context.io.stderr(`Directory ${invocation.server.docroot} does not exist.\n`);
      return { kind: 'exited', code: 1 };
    }
    const optional = invocation.server.routerIfPresent ? resolveFrom(context.cwd, invocation.server.routerIfPresent) : undefined;
    const router = invocation.server.router ? resolveFrom(context.cwd, invocation.server.router) : optional && isFile(module.FS, optional) ? optional : undefined;
    if (router && !isFile(module.FS, router)) {
      context.io.stderr(`Could not open input file: ${invocation.server.router}\n`);
      return { kind: 'exited', code: 1 };
    }
    const server = await startPhpWebServer(invocation.server, {
      php,
      files: { isFile: (path) => isFile(module.FS, path), isDir: (path) => isDir(module.FS, path), read: (path) => module.FS.readFile(path), write: (path, data) => module.FS.writeFile(path, data), mkdirTree: (path) => module.FS.mkdirTree(path) },
      docroot,
      router,
      env: { ...context.env },
      log: (text) => context.io.stderr(text),
      phpVersion: version,
    });
    return {
      kind: 'serving',
      server: { port: server.spec.port, handle: server.handle, close: async () => undefined },
      banner: `[${new Date().toUTCString()}] PHP ${version} Development Server (http://${invocation.server.host}:${invocation.server.port}) started (request-driven)\n`,
    };
  }
  const response = await php.cli(['php', ...invocation.argv], { env: { ...context.env } });
  await Promise.all([drainBytes(response.stdout, (bytes) => context.io.stdout(bytes)), drainText(response.stderr, (text) => context.io.stderr(text))]);
  return { kind: 'exited', code: await response.exitCode };
}
