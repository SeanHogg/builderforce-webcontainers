/**
 * The ONE way a Rust process's outbound virtual TCP is dialled
 * (rustBridge.ts `connect` → here → the process protocol's `dial`).
 *
 * Attribution is page-side by design: the worker sends no identity with a
 * dial. The page knows which Worker (or relay port) a `dial` message arrived
 * on and attributes it there; a field the worker could set would be one a
 * module could forge. A dial the page denies looks like nothing listening
 * (ECONNREFUSED: the guest's `recv` answers REFUSED).
 */
import type { Dial } from './rustBridge.js';

/** Dial through `transport` (the worker's dialled connections): the one choke point every Rust dial passes. */
export function createRustDial(transport: Dial): Dial {
  return (port) => transport(port);
}
