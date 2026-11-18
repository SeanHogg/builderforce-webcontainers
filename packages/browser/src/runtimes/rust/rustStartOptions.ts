/**
 * The Rust Worker kind. Rust processes need no host instructions in the start
 * message: the module they run is a project file (prebuilt wasm32-wasip1), and
 * the WASI host is part of the Worker.
 */
import type { WorkerKind } from '../../node/protocol.js';

/** The Worker kind Rust processes run in — the one constant for it. */
export const RUST_KIND = 'rust' satisfies WorkerKind;
