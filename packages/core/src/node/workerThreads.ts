/**
 * `worker_threads`, as processes. A `Worker` is a node process started with a
 * message channel and its `workerData` — in the browser runtime, its own Web
 * Worker, so it really runs in parallel. Inside it, `isMainThread` is false and
 * `parentPort` is that channel. There is no shared memory (no SharedArrayBuffer
 * without cross-origin isolation, which this runtime never requires), so
 * messages are copied and `transferList` ports cannot move between threads.
 *
 * On the wire every message is an envelope, so a worker's uncaught error reaches
 * the parent's `'error'` listener as an Error, the way Node reports it.
 */
import { EventEmitterBase } from './events.js';
import { Readable } from './stream/readable.js';
import type { EventLoop } from './loop.js';
import type { ChildHandle, StdioChunk, System, ThreadInfo } from '../system/types.js';
import { Buffer } from './buffer.js';
import type { IpcEndpoint } from '../system/ipc.js';
import { join } from '../paths.js';
import { keepAliveWhileListened, type ChannelKeepAlive } from './ipc.js';

type Envelope = { kind: 'message'; value: unknown } | { kind: 'error'; error: { name: string; message: string; stack?: string } };

/** The envelope a worker thread sends its parent when it dies of an uncaught error. */
export function threadErrorEnvelope(error: unknown): Envelope {
  const e = error instanceof Error ? error : new Error(String(error));
  return { kind: 'error', error: { name: e.name, message: e.message, stack: e.stack } };
}

function errorFrom(envelope: Extract<Envelope, { kind: 'error' }>): Error {
  const error = new Error(envelope.error.message);
  error.name = envelope.error.name;
  if (envelope.error.stack) error.stack = envelope.error.stack;
  return error;
}

export interface WorkerThreadsDeps {
  system: System;
  loop: EventLoop;
  cwd(): string;
  env(): Record<string, string | undefined>;
  stdout(chunk: StdioChunk): void;
  stderr(chunk: StdioChunk): void;
  /** Set when this process is itself a worker thread. */
  thread?: ThreadInfo;
  /** Its channel to the parent (the thread's `parentPort`). */
  ipc?: IpcEndpoint;
}

interface WorkerOptions {
  workerData?: unknown;
  eval?: boolean;
  argv?: unknown[];
  env?: Record<string, string | undefined> | symbol;
  stdout?: boolean;
  stderr?: boolean;
  name?: string;
}

let nextThreadId = 1;

/** The `parentPort` of a worker thread: messages to and from the parent. */
class ParentPort extends EventEmitterBase {
  private readonly keepAlive: ChannelKeepAlive;

  constructor(private readonly ipc: IpcEndpoint, loop: EventLoop) {
    super();
    this.keepAlive = keepAliveWhileListened(this, ['message'], loop, () => ipc.connected, () => {
      ipc.onMessage((envelope) => {
        const { kind, value } = envelope as Extract<Envelope, { kind: 'message' }>;
        if (kind === 'message') loop._run(() => this.emit('message', value));
      });
    });
    ipc.onDisconnect(() => {
      loop._run(() => this.emit('close'));
      this.keepAlive.update();
    });
  }

  postMessage(value: unknown): void {
    this.ipc.send({ kind: 'message', value } satisfies Envelope);
  }
  close(): void {
    this.ipc.disconnect();
  }
  start(): void {}
  ref(): this {
    this.keepAlive.ref();
    return this;
  }
  unref(): this {
    this.keepAlive.unref();
    return this;
  }
}

export function createWorkerThreadsModule(deps: WorkerThreadsDeps): Record<string, unknown> {
  const { loop } = deps;
  const environmentData = new Map<unknown, unknown>();

  class Worker extends EventEmitterBase {
    readonly threadId = nextThreadId++;
    readonly resourceLimits = {};
    readonly stdin = null;
    readonly stdout: Readable;
    readonly stderr: Readable;
    private readonly handle?: ChildHandle;
    private release?: () => void;
    private terminated = false;

    constructor(filename: string | URL, options: WorkerOptions = {}) {
      super();
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });
      const source = filename instanceof URL ? decodeURIComponent(filename.pathname) : String(filename);
      const script = options.eval ? ['-e', source] : [source.startsWith('/') ? source : join(deps.cwd(), source)];
      const env: Record<string, string> = {};
      const fromParent = typeof options.env === 'object' ? options.env : deps.env();
      for (const [key, value] of Object.entries(fromParent)) if (value !== undefined) env[key] = String(value);

      this.release = loop.hold();
      try {
        this.handle = deps.system.spawn('node', [...script, ...(options.argv ?? []).map(String)], {
          cwd: deps.cwd(),
          env,
          ipc: true,
          thread: { threadId: this.threadId, workerData: options.workerData ?? null },
        });
      } catch (error) {
        this.releaseLoop();
        queueMicrotask(() => loop._run(() => this.emit('error', error)));
        return;
      }
      const handle = this.handle;
      handle.onStdout((chunk) => (options.stdout ? this.stdout.push(Buffer.from(chunk)) : deps.stdout(chunk)));
      handle.onStderr((chunk) => (options.stderr ? this.stderr.push(Buffer.from(chunk)) : deps.stderr(chunk)));
      handle.ipc?.onMessage((message) => {
        const envelope = message as Envelope;
        loop._run(() => (envelope.kind === 'error' ? this.emit('error', errorFrom(envelope)) : this.emit('message', envelope.value)));
      });
      queueMicrotask(() => loop._run(() => this.emit('online')));
      void handle.exit.then((code) => {
        this.stdout.push(null);
        this.stderr.push(null);
        loop._run(() => this.emit('exit', this.terminated ? 1 : code));
        this.releaseLoop();
      });
    }

    postMessage(value: unknown): void {
      this.handle?.ipc?.send({ kind: 'message', value } satisfies Envelope);
    }

    /** Stop the thread; resolves with its exit code. */
    terminate(): Promise<number> {
      if (!this.handle) return Promise.resolve(1);
      this.terminated = true;
      this.handle.kill('SIGKILL');
      return this.handle.exit.then(() => 1);
    }

    ref(): this {
      if (!this.release && !this.terminated) this.release = loop.hold();
      return this;
    }
    unref(): this {
      this.releaseLoop();
      return this;
    }
    getHeapSnapshot(): Promise<never> {
      return Promise.reject(Object.assign(new Error('Heap snapshots are not available in the browser runtime'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }));
    }

    private releaseLoop(): void {
      this.release?.();
      this.release = undefined;
    }
  }

  const inThread = !!deps.thread && !!deps.ipc;
  return {
    isMainThread: !inThread,
    parentPort: inThread ? new ParentPort(deps.ipc!, loop) : null,
    workerData: deps.thread?.workerData ?? null,
    threadId: deps.thread?.threadId ?? 0,
    resourceLimits: {},
    Worker,
    MessageChannel: globalThis.MessageChannel,
    MessagePort: globalThis.MessagePort,
    BroadcastChannel: globalThis.BroadcastChannel,
    receiveMessageOnPort: () => undefined,
    markAsUntransferable: () => undefined,
    isMarkedAsUntransferable: () => false,
    moveMessagePortToContext: (port: unknown) => port,
    setEnvironmentData: (key: unknown, value: unknown) => void environmentData.set(key, value),
    getEnvironmentData: (key: unknown) => environmentData.get(key),
    SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
  };
}
