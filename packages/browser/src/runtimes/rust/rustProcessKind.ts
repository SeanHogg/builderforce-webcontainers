/**
 * The Rust runtime's process-kind policy for the process host
 * (node/processKinds.ts): prebuilt modules (`./target/wasm32-wasip1/release/api.wasm`),
 * `wasmtime`, and the toolchain commands it declines with the reason (`cargo`,
 * `rustc`, `rustup`) run in a Rust process Worker. Every other command goes to
 * `next`, so one host chains the runtimes:
 * `createRustProcessKind(createDotnetProcessKind(options.dotnet, php))`.
 * Rust processes need no host instructions, so their start message carries none.
 */
import { NODE_ONLY, unionCommandPatterns, type ProcessKindPolicy, type ProcessRoute } from '../../node/processKinds.js';
import { RUST_COMMAND_PATTERN, isRustCommand } from './rustCommand.js';
import { RUST_KIND } from './rustStartOptions.js';

export { RUST_KIND };

export function createRustProcessKind(next: ProcessKindPolicy = NODE_ONLY): ProcessKindPolicy {
  return {
    foreignCommands: unionCommandPatterns(RUST_COMMAND_PATTERN, next.foreignCommands),
    route(command, args, context): ProcessRoute {
      return isRustCommand(command) ? { kind: RUST_KIND, command, args } : next.route(command, args, context);
    },
    startOptions: (kind) => (kind === RUST_KIND ? {} : next.startOptions(kind)),
    receive: (kind, message) => kind !== RUST_KIND && next.receive(kind, message),
  };
}
