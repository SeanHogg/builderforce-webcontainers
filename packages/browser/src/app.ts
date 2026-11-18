/**
 * `@seanhogg/builderforce-webcontainers/app` — the application runtime: run an
 * application of several services (a frontend, an API, …) in this runtime as
 * one app, each started after what it depends on is ready, with per-service
 * environment, logs, lifecycle and restart policy. Kept off the package root so
 * preview-only consumers never load it. Re-exports the pure half
 * (`@seanhogg/builderforce-webcontainers-core/app`): the spec, its validation,
 * the service graph and the `RuntimeProvider` port.
 */
export { startApplicationRuntime } from './app/startApplicationRuntime.js';
export { ApplicationStartError } from './app/types.js';
export { ServiceFailure } from './app/awaitReadiness.js';
export type { ApplicationRuntime, ApplicationRuntimeOptions, ServiceError, ServiceErrorPhase, ServiceLogEntry, ServiceSnapshot } from './app/types.js';
export { createNodeProvider, acceptsNodeService, NODE_DECLINED_COMMANDS, NODE_READINESS } from './app/nodeProvider.js';
export type { NodeProviderOptions } from './app/nodeProvider.js';
export type { NodeServiceHost } from './app/nodeReadiness.js';
export { createPgliteProvider, acceptsPgliteService, pgliteDataDir } from './app/pgliteProvider.js';
export type { DatabaseServiceHost, PgliteProviderOptions } from './app/pgliteProvider.js';
export { startDatabaseHost } from './database/databaseHost.js';
export type { DatabaseHost, DatabaseHostOptions } from './database/databaseHost.js';
export { claimDatabase, DatabaseCoordinationError } from './database/databaseLeadership.js';
export type { DatabaseOwnership, LockManagerLike } from './database/databaseLeadership.js';
export { DEFAULT_PGLITE_URL, PGLITE_VERSION } from './database/pgliteLoader.js';
// The Python runtime: the `python` provider, its command/requirements rules, the socket seam.
export * from './runtimes/python/index.js';
// The PHP runtime: the `php` provider, `php -S`, Composer, PHP sockets and the runtime's Postgres PDO.
export * from './runtimes/php/index.js';
// The .NET runtime: the `dotnet` provider, in-browser builds, ASP.NET Core on virtual ports, Npgsql over virtual TCP.
export * from './runtimes/dotnet/index.js';
// The Rust runtime: the `rust` provider, prebuilt wasm32-wasip1 modules on the WASI host, axum services, tokio-postgres over virtual TCP.
export * from './runtimes/rust/index.js';
// What the interpreter runtimes share: paths against a directory (core's, re-exported: `./app` published it), hearing writes in an Emscripten FS without hooks.
export { resolveFrom } from '@seanhogg/builderforce-webcontainers-core';
export { trackWrappedFsWrites } from './runtimes/emscripten/wrappedFsWrites.js';
export type { EmscriptenFsStream, WrappableEmscriptenFs } from './runtimes/emscripten/wrappedFsWrites.js';
export type { ProcessKindPolicy, PythonExtensionRef, WorkerKind } from './node/index.js';
export * from '@seanhogg/builderforce-webcontainers-core/app';
