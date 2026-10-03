/**
 * The small builtins: os, tty, timers (+promises), string_decoder, perf_hooks,
 * async_hooks, worker_threads, vm, dns, v8, diagnostics_channel and stubs for
 * the ones with nothing to offer in a browser (cluster, inspector). Each exists
 * so `require` succeeds and the common calls behave plausibly.
 */
import { EventEmitterBase } from './events.js';
import type { EventLoop } from './loop.js';
import { decode } from './buffer.js';
import { callable } from './callable.js';

export function createOsModule(env: () => Record<string, string | undefined>): Record<string, unknown> {
  const cpus = Array.from({ length: Math.max(1, Math.min(16, globalThis.navigator?.hardwareConcurrency ?? 4)) }, () => ({
    model: 'Browser CPU',
    speed: 2400,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
  return {
    EOL: '\n',
    devNull: '/dev/null',
    platform: () => 'linux',
    type: () => 'Linux',
    release: () => '6.1.0-bfwc',
    version: () => '#1 SMP BuilderForce WebContainers',
    machine: () => 'x86_64',
    arch: () => 'x64',
    hostname: () => 'localhost',
    homedir: () => env().HOME ?? '/home/user',
    tmpdir: () => env().TMPDIR ?? '/tmp',
    userInfo: () => ({ uid: 1000, gid: 1000, username: env().USER ?? 'user', homedir: env().HOME ?? '/home/user', shell: '/bin/jsh' }),
    cpus: () => cpus,
    availableParallelism: () => cpus.length,
    totalmem: () => 4 * 1024 ** 3,
    freemem: () => 2 * 1024 ** 3,
    loadavg: () => [0, 0, 0],
    uptime: () => Math.floor(performance.now() / 1000),
    networkInterfaces: () => ({ lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] }),
    endianness: () => 'LE',
    getPriority: () => 0,
    setPriority: () => undefined,
    constants: { signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }, errno: {}, priority: {} },
  };
}

export function createTtyModule(isTerminal: boolean): Record<string, unknown> {
  return {
    isatty: (fd: number) => isTerminal && fd >= 0 && fd <= 2,
    ReadStream: class extends EventEmitterBase {},
    WriteStream: class extends EventEmitterBase {},
  };
}

export function createTimersModule(loop: EventLoop): Record<string, unknown> {
  const promises = {
    setTimeout: (ms?: number, value?: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const t = loop.setTimeout(() => resolve(value), ms);
        options?.signal?.addEventListener('abort', () => {
          loop.clearTimeout(t);
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        });
      }),
    setImmediate: (value?: unknown) => new Promise((resolve) => loop.setImmediate(() => resolve(value))),
    async *setInterval(ms?: number, value?: unknown) {
      while (true) {
        await new Promise((resolve) => loop.setTimeout(resolve, ms));
        yield value;
      }
    },
    scheduler: { wait: (ms: number) => new Promise((resolve) => loop.setTimeout(resolve, ms)), yield: () => new Promise((resolve) => loop.setImmediate(resolve)) },
  };
  return {
    setTimeout: loop.setTimeout,
    clearTimeout: loop.clearTimeout,
    setInterval: loop.setInterval,
    clearInterval: loop.clearInterval,
    setImmediate: loop.setImmediate,
    clearImmediate: loop.clearImmediate,
    promises,
  };
}

export function createStringDecoderModule(): Record<string, unknown> {
  const init = (self: { encoding: string; utf8?: TextDecoder }, encoding?: string) => {
    self.encoding = (encoding ?? 'utf8').toLowerCase().replace('-', '');
    if (self.encoding === 'utf8') self.utf8 = new TextDecoder('utf-8');
  };
  class StringDecoderBase {
    declare encoding: string;
    declare utf8?: TextDecoder;
    constructor(encoding?: string) {
      init(this, encoding);
    }
    write(chunk: Uint8Array | string): string {
      if (typeof chunk === 'string') return chunk;
      return this.utf8 ? this.utf8.decode(chunk, { stream: true }) : decode(chunk, this.encoding);
    }
    end(chunk?: Uint8Array | string): string {
      const head = chunk === undefined ? '' : this.write(chunk);
      return head + (this.utf8 ? this.utf8.decode() : '');
    }
  }
  // iconv-lite (body-parser) subclasses it the pre-ES2015 way: StringDecoder.call(this, enc).
  return { StringDecoder: callable(StringDecoderBase, init) };
}

export function createAsyncHooksModule(): Record<string, unknown> {
  /**
   * Context does not propagate across awaits here (that needs engine support);
   * `run` scopes the store for synchronous code and whatever reads it in the
   * same tick, which is how most request-scoped loggers use it.
   */
  class AsyncLocalStorage<T> {
    private store: T | undefined;
    getStore(): T | undefined {
      return this.store;
    }
    run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
      const previous = this.store;
      this.store = store;
      try {
        return fn(...args);
      } finally {
        this.store = previous;
      }
    }
    enterWith(store: T): void {
      this.store = store;
    }
    exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
      return this.run(undefined as T, fn, ...args);
    }
    disable(): void {
      this.store = undefined;
    }
    static bind<F>(fn: F): F {
      return fn;
    }
    static snapshot() {
      return <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => fn(...args);
    }
  }
  class AsyncResource {
    constructor(readonly type: string) {}
    runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
      return fn.apply(thisArg, args);
    }
    bind<F>(fn: F): F {
      return fn;
    }
    static bind<F>(fn: F): F {
      return fn;
    }
    emitDestroy(): this {
      return this;
    }
    asyncId(): number {
      return 1;
    }
    triggerAsyncId(): number {
      return 0;
    }
  }
  return {
    AsyncLocalStorage,
    AsyncResource,
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    executionAsyncId: () => 1,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
  };
}

export function createVmModule(): Record<string, unknown> {
  const run = (code: string, context: Record<string, unknown> = {}) => {
    const names = Object.keys(context).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
    return new Function(...names, `return eval(${JSON.stringify(code)})`)(...names.map((n) => context[n]));
  };
  class Script {
    constructor(private readonly code: string) {}
    runInThisContext(): unknown {
      return (0, eval)(this.code);
    }
    runInNewContext(context?: Record<string, unknown>): unknown {
      return run(this.code, context);
    }
    runInContext(context: Record<string, unknown>): unknown {
      return run(this.code, context);
    }
  }
  return {
    Script,
    runInThisContext: (code: string) => (0, eval)(code),
    runInNewContext: run,
    runInContext: run,
    createContext: (context: Record<string, unknown> = {}) => context,
    isContext: () => true,
    compileFunction: (code: string, params: string[] = []) => new Function(...params, code),
  };
}

export function createDiagnosticsChannelModule(): Record<string, unknown> {
  const channels = new Map<string, { subscribers: Set<(message: unknown, name: string) => void>; name: string }>();
  const channel = (name: string) => {
    let c = channels.get(name);
    if (!c) {
      const subscribers = new Set<(message: unknown, name: string) => void>();
      c = Object.assign({ subscribers, name }, {
        get hasSubscribers() { return subscribers.size > 0; },
        publish: (message: unknown) => subscribers.forEach((s) => s(message, name)),
        subscribe: (fn: (message: unknown, name: string) => void) => void subscribers.add(fn),
        unsubscribe: (fn: (message: unknown, name: string) => void) => subscribers.delete(fn),
      });
      channels.set(name, c);
    }
    return c;
  };
  return {
    channel,
    hasSubscribers: (name: string) => (channels.get(name)?.subscribers.size ?? 0) > 0,
    subscribe: (name: string, fn: (m: unknown, n: string) => void) => channel(name).subscribers.add(fn),
    unsubscribe: (name: string, fn: (m: unknown, n: string) => void) => channel(name).subscribers.delete(fn),
    tracingChannel: (name: string) => ({ start: channel(`tracing:${name}:start`), end: channel(`tracing:${name}:end`), error: channel(`tracing:${name}:error`), traceSync: <R>(fn: () => R) => fn(), tracePromise: <R>(fn: () => R) => fn() }),
  };
}

const unavailable = (name: string) => () => {
  throw Object.assign(new Error(`${name} is not available in the browser runtime`), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' });
};

export function createStubModules(): Record<string, Record<string, unknown>> {
  return {
    perf_hooks: { performance: globalThis.performance, PerformanceObserver: class { observe() {} disconnect() {} }, monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0, mean: 0, max: 0, min: 0 }), constants: {} },
    worker_threads: { isMainThread: true, parentPort: null, workerData: null, threadId: 0, resourceLimits: {}, Worker: unavailable('worker_threads.Worker'), MessageChannel, MessagePort: globalThis.MessagePort, BroadcastChannel: globalThis.BroadcastChannel, markAsUntransferable: () => undefined, SHARE_ENV: Symbol('SHARE_ENV') },
    dns: { lookup: (host: string, options: unknown, cb?: (e: Error | null, address: string, family: number) => void) => queueMicrotask(() => ((typeof options === 'function' ? options : cb) as NonNullable<typeof cb>)(null, host === 'localhost' ? '127.0.0.1' : host, 4)), resolve: unavailable('dns.resolve'), promises: { lookup: async (host: string) => ({ address: host === 'localhost' ? '127.0.0.1' : host, family: 4 }) }, setDefaultResultOrder: () => undefined },
    v8: { getHeapStatistics: () => ({ total_heap_size: 30e6, used_heap_size: 20e6, heap_size_limit: 2e9 }), getHeapSpaceStatistics: () => [], serialize: (v: unknown) => new TextEncoder().encode(JSON.stringify(v)), deserialize: (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)), setFlagsFromString: () => undefined, cachedDataVersionTag: () => 0 },
    cluster: { isMaster: true, isPrimary: true, isWorker: false, workers: {}, fork: unavailable('cluster.fork'), on: () => undefined, settings: {} },
    inspector: { open: () => undefined, close: () => undefined, url: () => undefined, Session: class { connect() {} post() {} disconnect() {} }, console: globalThis.console },
    punycode: { toASCII: (s: string) => new URL(`http://${s}`).hostname, toUnicode: (s: string) => s, encode: (s: string) => s, decode: (s: string) => s, ucs2: { decode: (s: string) => Array.from(s, (c) => c.codePointAt(0)!), encode: (a: number[]) => String.fromCodePoint(...a) } },
    tls: { connect: unavailable('tls.connect'), createServer: unavailable('tls.createServer'), createSecureContext: () => ({}), DEFAULT_MIN_VERSION: 'TLSv1.2', DEFAULT_MAX_VERSION: 'TLSv1.3', rootCertificates: [] },
    dgram: { createSocket: unavailable('dgram.createSocket') },
    http2: { connect: unavailable('http2.connect'), createServer: unavailable('http2.createServer'), createSecureServer: unavailable('http2.createSecureServer'), constants: {} },
    trace_events: { createTracing: () => ({ enable() {}, disable() {} }), getEnabledCategories: () => '' },
    sqlite: { DatabaseSync: unavailable('sqlite.DatabaseSync') },
    test: { test: unavailable('node:test'), describe: unavailable('node:test'), it: unavailable('node:test') },
    wasi: { WASI: unavailable('wasi.WASI') },
    repl: { start: unavailable('repl.start') },
    domain: { create: () => Object.assign(new EventEmitterBase(), { run: (fn: () => unknown) => fn(), add() {}, remove() {}, bind: <F>(fn: F) => fn, intercept: <F>(fn: F) => fn, enter() {}, exit() {}, dispose() {} }) },
  };
}
