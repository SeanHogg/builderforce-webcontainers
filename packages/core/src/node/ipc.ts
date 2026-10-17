/**
 * The Node face of a process's message channel (system/ipc.ts): `process.send`,
 * `process.on('message')`, `process.connected` / `disconnect()` in a forked
 * child, and the keep-alive rule both it and `worker_threads`' `parentPort` follow.
 */
import type { EventEmitterBase } from './events.js';
import type { EventLoop } from './loop.js';
import type { NodeProcess } from './process.js';
import type { IpcEndpoint } from '../system/ipc.js';

export interface ChannelKeepAlive {
  /** Re-check whether the channel should hold the process open. */
  update(): void;
  ref(): void;
  unref(): void;
  hasRef(): boolean;
}

/**
 * Node keeps a process alive for an open channel only while something listens to
 * it (`events`) and nobody `unref()`ed it. `onFirstListener` runs once, when the
 * first such listener arrives — the moment to start receiving, so messages sent
 * before then wait in the channel instead of being emitted to no one.
 */
export function keepAliveWhileListened(emitter: EventEmitterBase, events: readonly string[], loop: EventLoop, open: () => boolean, onFirstListener: () => void): ChannelKeepAlive {
  let release: (() => void) | undefined;
  let referenced = true;
  let started = false;
  const listened = () => events.some((event) => emitter.listenerCount(event) > 0);
  const update = () => {
    if (!started && listened()) {
      started = true;
      onFirstListener();
    }
    const want = referenced && open() && listened();
    if (want && !release) release = loop.hold();
    else if (!want && release) {
      release();
      release = undefined;
    }
  };
  // `newListener` fires before the listener is added: look once it is in place.
  const changed = (event: string | symbol) => {
    if (typeof event === 'string' && events.includes(event)) queueMicrotask(update);
  };
  emitter.on('newListener', changed);
  emitter.on('removeListener', changed);
  return {
    update,
    ref() {
      referenced = true;
      update();
    },
    unref() {
      referenced = false;
      update();
    },
    hasRef: () => referenced,
  };
}

type Callback = (error: Error | null) => void;

/** Give a forked child's `process` its channel to the parent. */
export function attachProcessChannel(proc: NodeProcess, ipc: IpcEndpoint, loop: EventLoop): void {
  const keepAlive = keepAliveWhileListened(proc, ['message', 'disconnect'], loop, () => ipc.connected, () => {
    ipc.onMessage((message) => loop._run(() => proc.emit('message', message, undefined)));
  });
  ipc.onDisconnect(() => {
    proc.connected = false;
    loop._run(() => proc.emit('disconnect'));
    keepAlive.update();
  });
  Object.assign(proc, {
    connected: true,
    channel: { ref: keepAlive.ref, unref: keepAlive.unref, hasRef: keepAlive.hasRef },
    send(message: unknown, ...rest: unknown[]): boolean {
      const callback = rest.find((arg): arg is Callback => typeof arg === 'function');
      try {
        ipc.send(message);
      } catch (error) {
        if (!callback) throw error;
        queueMicrotask(() => loop._run(() => callback(error as Error)));
        return false;
      }
      if (callback) queueMicrotask(() => loop._run(() => callback(null)));
      return true;
    },
    disconnect: () => ipc.disconnect(),
  });
}
