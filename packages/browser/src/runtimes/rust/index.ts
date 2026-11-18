/**
 * The Rust runtime (PRD 31 §W9 phase 6d): prebuilt wasm32-wasip1 modules on
 * the preview1 WASI host in a process Worker — WASI commands, and axum
 * services (the bfwc-wasi crate) answered per request like a wasi:http
 * handler, with tokio-postgres over the runtime's virtual TCP. No in-browser
 * compiler: the gate has not passed (`RUST_COMPILE_GATE`). The public surface
 * the package's `./app` re-exports: the provider and its rules, the process
 * kind. The bridge and the module runner stay internal — they would take a raw
 * dial past the one dial choke point (rustDial.ts).
 */
export { RUST_COMPILE_GATE, RUST_PROFILE, isRustCommand, parseRustCommand } from './rustCommand.js';
export type { RustCommandParse, RustInvocation } from './rustCommand.js';
export { RUST_KIND, createRustProcessKind } from './rustProcessKind.js';
export { acceptsRustService, createRustProvider } from './rustProvider.js';
export type { RustProviderOptions } from './rustProvider.js';
