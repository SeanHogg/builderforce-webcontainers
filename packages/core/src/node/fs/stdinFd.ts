/**
 * fd 0 as a file: `fs.read(0, buffer, …, callback)` waits for the process's stdin
 * and fills the buffer from it, as on a pipe. Go's WebAssembly runtime reads its
 * input this way (esbuild-wasm's service process, which Vite drives).
 */
import type { ProgramIO } from '../../system/types.js';

/** Read up to `into.length` bytes of stdin; resolves 0 at end of input. */
export type StdinRead = (into: Uint8Array) => Promise<number>;

export function createStdinRead(io: ProgramIO, hold: () => () => void): StdinRead {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let wake: Array<() => void> = [];
  let subscribed = false;

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    io.onStdin((chunk) => {
      if (chunk === null) ended = true;
      else chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
      const waiting = wake;
      wake = [];
      for (const resume of waiting) resume();
    });
  };

  return async (into) => {
    subscribe();
    while (!chunks.length && !ended) {
      const release = hold(); // a pending read keeps the process alive, as Node's does
      await new Promise<void>((resolve) => wake.push(resolve));
      release();
    }
    const head = chunks[0];
    if (!head) return 0;
    const count = Math.min(head.length, into.length);
    into.set(head.subarray(0, count));
    if (count === head.length) chunks.shift();
    else chunks[0] = head.subarray(count);
    return count;
  };
}
