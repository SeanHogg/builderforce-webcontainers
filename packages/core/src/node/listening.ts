/**
 * When a server's `listen` is settled — shared by `http.Server` and
 * `net.Server`. In-process the registration is final at once; in a process
 * Worker the page's port table answers (`ready`), and a refusal (another
 * process took the port first) must surface as Node does: an `'error'` event
 * with an `EADDRINUSE` error, the server not listening, and no `'listening'`.
 */
import type { ListenRegistration } from '../system/types.js';
import { queueCallback } from './processExit.js';

/**
 * Call `settled()` once the registration is confirmed, or `settled(error)` once
 * it was refused — on a later tick either way, and only while `isCurrent()`
 * (the server was not closed or re-listened meanwhile).
 */
export function whenListening(registration: ListenRegistration, isCurrent: () => boolean, settled: (error?: unknown) => void): void {
  if (!registration.ready) return queueCallback(() => isCurrent() && settled());
  registration.ready.then(
    () => queueCallback(() => isCurrent() && settled()),
    (error: unknown) => queueCallback(() => isCurrent() && settled(error)),
  );
}
