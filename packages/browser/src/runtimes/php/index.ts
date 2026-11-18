/**
 * The PHP runtime (PRD 31 §W9 phase 6b): php-wasm in a process Worker, PHP's
 * CLI, `php -S` served request-driven on virtual ports, Composer installs of
 * pure-PHP packages, PHP sockets over virtual TCP, and Postgres through the
 * runtime's PDO (`Bfwc\Pgsql\PDO`). For the package's `./app` to re-export.
 */
export { PHP_WASM_VERSION, PHP_WASM_RELEASES, DEFAULT_PHP_VERSION, SUPPORTED_PHP_VERSIONS, DEFAULT_PHP_WASM_BASE_URL, checkPhpVersion, loadPhpRuntime, phpWasmModuleUrls } from './phpLoader.js';
export type { LoadedPhp, PhpLike, PhpLoadOptions, PhpModuleLike, PhpRunRequest, PhpStreamedResponse } from './phpLoader.js';
export { PHP_COMMAND_PATTERN, isPhpCommand, mapInvocationPaths as mapPhpInvocationPaths, parsePhpCommand } from './phpCommand.js';
export type { ComposerCommand, ComposerRequest, PhpCommandParse, PhpInvocation, PhpServerSpec } from './phpCommand.js';
export { PHP_KIND, createPhpProcessKind } from './phpProcessKind.js';
export type { PhpHostOptions, PhpPlatformRecord, PhpProcessKind } from './phpProcessKind.js';
export type { ComposerSourceOptions, PhpStartOptions } from './phpStartOptions.js';
export { createPhpWorkerProcess } from './phpWorkerProcess.js';
export type { PhpWorkerProcessDeps } from './phpWorkerProcess.js';
export { FRONT_SCRIPT, frontScript, routeRequest, startPhpWebServer } from './phpWebServer.js';
export type { PhpWebServer, PhpWebServerContext } from './phpWebServer.js';
export { dialSocketClass, installPhpSockets, isLocalAddress } from './phpSockets.js';
export type { Dial } from './phpSockets.js';
export { fromPhpPath, toPhpPath } from './phpFs.js';
/** @deprecated Published in 2026.11.3; the tracker is shared by every Emscripten runtime without hooks — use `trackWrappedFsWrites`. */
export { trackWrappedFsWrites as trackPhpWrites } from '../emscripten/wrappedFsWrites.js';
/** @deprecated Published in 2026.11.3 — use `WrappableEmscriptenFs`. */
export type { WrappableEmscriptenFs as PhpEmscriptenFs } from '../emscripten/wrappedFsWrites.js';
export { RUNTIME_LIBRARY_ROOT, installRuntimeLibrary } from './phpRuntimeLibrary.js';
export { PHP_WASM_EXTENSIONS, acceptsPhpService, createPhpProvider, expectedPlatform } from './phpProvider.js';
export type { PhpProviderOptions } from './phpProvider.js';
export { runComposer } from './composer/composerInstall.js';
export { InvalidPackageName, checkPackageName, encodePackageName, validPackageName } from './composer/packageName.js';
export { lockText, requireArguments, runtimePackages, unsupportedRepositories } from './composer/lockFile.js';
export type { ComposerJson, LockFile } from './composer/lockFile.js';
export type { ComposerContext } from './composer/composerInstall.js';
export { DIST_LIMITS, DistRefused, MAX_RESPONSE_BYTES, checkDistUrl, createPackageSource, expandMinified, githubRepository, readCapped, unpackDist, versionsOf, DEFAULT_REPOSITORY_URL } from './composer/packagist.js';
export type { Autoload, PackageSource, PackageSourceOptions, PackageVersion } from './composer/packagist.js';
export { PGSQL_REASON, isPlatformPackage, platformShortfall } from './composer/platform.js';
export type { Platform } from './composer/platform.js';
export { ResolveError, pickVersion, rankVersions, resolvePackages, rootRequirements } from './composer/resolve.js';
export type { Requirement as ComposerRequirement, ResolveOptions, RootLinks } from './composer/resolve.js';
export { compareVersions, parseConstraint, parseVersion, satisfies } from './composer/semver.js';
export type { Constraint, Stability, Version } from './composer/semver.js';
export { declaredClasses, dependencyOrder, writeAutoloader } from './composer/autoload.js';
export { phpLiteral, phpString } from './phpLiteral.js';
export type { ComposerFiles } from './composer/autoload.js';
