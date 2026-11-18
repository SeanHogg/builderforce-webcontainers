/**
 * The `rust` runtime provider for `startApplicationRuntime`. It declares one
 * profile — {@link RUST_PROFILE}: prebuilt wasm32-wasip1 modules — and runs a
 * service whose command is such a module (a `.wasm` path, `wasmtime run
 * x.wasm`) as a Rust process, held to the same readiness as a Node service
 * (the Node provider's start is reused as is). Everything else is declined
 * with a reason, so the host can send the application to the container
 * target: `cargo`/`rustc` (no in-browser compiler: the gate has not passed),
 * other commands, and — given the project's files — a module that is missing
 * (not built yet), not wasm, or a preview 2 component.
 */
import { readinessOf, type Acceptance, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { createNodeProvider, type NodeProviderOptions } from '../../app/nodeProvider.js';
import type { NodeServiceHost } from '../../app/nodeReadiness.js';
import { resolveFrom } from '@seanhogg/builderforce-webcontainers-core';
import { PREBUILT_HINT, RUST_PROFILE, isRustCommand, parseRustCommand } from './rustCommand.js';
import { headerProblem, wasmHeader } from './rustModule.js';

export interface RustProviderOptions extends NodeProviderOptions {
  /** The project's files: with them, a module that is missing or cannot run is declined up front, with the reason. */
  fs?: VirtualFileSystem;
}

export function acceptsRustService(service: ServiceSpec, fs?: VirtualFileSystem): Acceptance {
  if (service.type !== 'application') return { ok: false, reason: `The rust runtime runs application services; "${service.id}" is a ${service.type} service.` };
  if (readinessOf(service).kind === 'query') return { ok: false, reason: `"query" readiness is for databases; service "${service.id}" runs on rust.` };
  const command = service.command;
  if (!command || !isRustCommand(command)) return { ok: false, reason: `Service "${service.id}": "${command ?? ''}" is not a Rust runtime command. The rust runtime runs ${RUST_PROFILE}.` };
  const parsed = parseRustCommand(command, service.args ?? []);
  if (!parsed.ok) return { ok: false, reason: `Service "${service.id}": ${parsed.reason}` };
  if (!fs) return { ok: true };
  const path = resolveFrom(resolveFrom('/', service.root ?? '/'), parsed.invocation.module);
  const contents = fs.readFile(path);
  if (contents === undefined) return { ok: false, reason: `Service "${service.id}": ${path} does not exist — the rust runtime runs prebuilt modules: ${PREBUILT_HINT}.` };
  const problem = headerProblem(path, typeof contents === 'string' ? 'not-wasm' : wasmHeader(contents));
  return problem ? { ok: false, reason: `Service "${service.id}": ${problem}` } : { ok: true };
}

/** `host` is the runtime (`startPreviewRuntime()`'s, or a `ProcessHost` adapted): it runs Rust commands in Rust Workers. */
export function createRustProvider(host: NodeServiceHost, options: RustProviderOptions = {}): RuntimeProvider {
  const { start } = createNodeProvider(host, options);
  return {
    id: 'rust',
    accepts: (service) => acceptsRustService(service, options.fs),
    start,
  };
}
