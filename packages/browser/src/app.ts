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
export * from '@seanhogg/builderforce-webcontainers-core/app';
