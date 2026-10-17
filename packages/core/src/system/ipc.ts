/**
 * A message channel between a process and the parent that started it — what
 * `child_process.fork()` opens (`child.send` ↔ `process.send`) and what a
 * `worker_threads` Worker talks over (`worker.postMessage` ↔ `parentPort`).
 *
 * One endpoint shape for every hop: in-process (the core kernel), and relayed
 * through the page between process Workers (the browser runtime). Messages are
 * structured-cloned, as Node's `serialization: 'advanced'` does, and delivered
 * asynchronously. Messages that arrive before the receiver subscribes wait for
 * it — a child attaching its `process.on('message')` while its module loads
 * still gets what the parent sent right after `fork()`.
 */
export interface IpcEndpoint {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  /** Close the channel; both ends hear `onDisconnect`. */
  disconnect(): void;
  onDisconnect(listener: () => void): () => void;
  readonly connected: boolean;
}

/**
 * An endpoint whose sends go out through `post` and whose incoming traffic the
 * owner feeds in: `receive(message)` for a message, `closed()` when the far end
 * went away. `onClose` runs once when THIS end disconnects (to tell the far end).
 */
export function createIpcEndpoint(post: (message: unknown) => void, onClose: () => void = () => undefined) {
  const listeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  let backlog: unknown[] = [];
  let connected = true;

  const close = (notifyFarEnd: boolean) => {
    if (!connected) return;
    connected = false;
    backlog = [];
    if (notifyFarEnd) onClose();
    queueMicrotask(() => disconnectListeners.forEach((listener) => listener()));
  };

  const endpoint: IpcEndpoint = {
    send(message) {
      if (!connected) throw Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });
      post(structuredClone(message));
    },
    onMessage(listener) {
      listeners.add(listener);
      if (backlog.length) {
        const waiting = backlog;
        backlog = [];
        queueMicrotask(() => waiting.forEach((message) => listener(message)));
      }
      return () => listeners.delete(listener);
    },
    disconnect: () => close(true),
    onDisconnect(listener) {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
    get connected() {
      return connected;
    },
  };

  return {
    endpoint,
    receive(message: unknown) {
      if (!connected) return;
      if (!listeners.size) backlog.push(message);
      else queueMicrotask(() => listeners.forEach((listener) => listener(message)));
    },
    closed: () => close(false),
  };
}

/** Two endpoints wired to each other, in one realm: the parent's and the child's. */
export function createIpcPair(): [IpcEndpoint, IpcEndpoint] {
  // eslint-disable-next-line prefer-const -- each side's `post` reaches the other, created after it
  let child: ReturnType<typeof createIpcEndpoint>;
  const parent = createIpcEndpoint(
    (message) => child.receive(message),
    () => child.closed(),
  );
  child = createIpcEndpoint(
    (message) => parent.receive(message),
    () => parent.closed(),
  );
  return [parent.endpoint, child.endpoint];
}
