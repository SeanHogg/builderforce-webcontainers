/**
 * Reading stdin one line at a time (`read`, `while read line`). A chunk can
 * hold several lines, so what follows the first newline is kept per queue and
 * served to the next read before any new chunk.
 */
import type { InputQueue } from '../system/terminal.js';

const leftovers = new WeakMap<InputQueue, string>();
const finished = new WeakSet<InputQueue>();

/** The next line without its newline, or `null` at end of input. */
export function readLine(queue: InputQueue, signal?: AbortSignal): Promise<string | null> {
  let buffer = leftovers.get(queue) ?? '';
  const take = (): string | null => {
    const newline = buffer.indexOf('\n');
    if (newline < 0) return null;
    leftovers.set(queue, buffer.slice(newline + 1));
    return buffer.slice(0, newline);
  };
  const ready = take();
  if (ready !== null) return Promise.resolve(ready);
  if (finished.has(queue)) {
    leftovers.delete(queue);
    return Promise.resolve(buffer ? buffer : null);
  }
  return new Promise((resolve) => {
    const settle = (line: string | null) => {
      stop();
      signal?.removeEventListener('abort', onAbort);
      resolve(line);
    };
    const onAbort = () => settle(null);
    signal?.addEventListener('abort', onAbort);
    const stop = queue.subscribe((chunk) => {
      if (chunk === null) {
        finished.add(queue);
        leftovers.delete(queue);
        settle(buffer ? buffer : null);
        return;
      }
      buffer += chunk;
      const line = take();
      if (line !== null) settle(line);
    });
  });
}
