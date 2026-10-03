/**
 * Node's "the process exits when there is nothing left to do", recreated.
 *
 * A browser has no way to ask "is anything still pending?", so the runtime
 * counts what Node would count: ref'd timers and intervals, listening servers,
 * open watchers, a flowing stdin, child processes and in-flight requests
 * (`hold()`). When the count reaches zero, an idle check runs on a later
 * macrotask — after every pending microtask (promise chains, fs callbacks) has
 * drained — and if still zero, the process exits.
 *
 * Timers are Node-shaped objects (`ref`/`unref`/`refresh`/`hasRef`), and errors
 * thrown from any callback are routed to the process as uncaught exceptions.
 */

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

type Callback = (...args: any[]) => void;

let nextTimerId = 1;

export class Timeout {
  readonly _id = nextTimerId++;
  _ref = true;
  _handle: ReturnType<typeof realSetTimeout> | undefined;
  _destroyed = false;

  constructor(
    private readonly loop: EventLoop,
    readonly _onTimeout: Callback,
    readonly _idleTimeout: number,
    private readonly args: unknown[],
    readonly _repeat: boolean,
  ) {}

  ref(): this {
    if (!this._ref && !this._destroyed) this.loop._refChanged(this, true);
    this._ref = true;
    return this;
  }

  unref(): this {
    if (this._ref && !this._destroyed) this.loop._refChanged(this, false);
    this._ref = false;
    return this;
  }

  hasRef(): boolean {
    return this._ref;
  }

  refresh(): this {
    if (!this._destroyed) this.loop._arm(this);
    return this;
  }

  close(): this {
    this.loop.clear(this);
    return this;
  }

  [Symbol.toPrimitive](): number {
    return this._id;
  }

  _fire(): void {
    this.loop._run(() => this._onTimeout(...this.args));
  }
}

export interface EventLoopOptions {
  /** Called once when nothing keeps the process alive. */
  onIdle(): void;
  /** An exception escaped a callback. */
  onError(error: unknown): void;
}

export class EventLoop {
  private holds = 0;
  private readonly timers = new Map<number, Timeout>();
  private refTimers = 0;
  private checkScheduled = false;
  private stopped = false;

  constructor(private readonly options: EventLoopOptions) {}

  /** Keep the process alive until the returned function is called (idempotent). */
  hold(): () => void {
    if (this.stopped) return () => undefined;
    this.holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.scheduleCheck();
    };
  }

  /** Run `fn` the way a callback from the loop runs: errors become uncaught exceptions. */
  _run(fn: () => void): void {
    if (this.stopped) return;
    try {
      fn();
    } catch (error) {
      this.options.onError(error);
    }
  }

  get alive(): boolean {
    return this.holds > 0 || this.refTimers > 0;
  }

  setTimeout = (fn: Callback, ms?: number, ...args: unknown[]): Timeout => this.add(fn, ms, args, false);
  setInterval = (fn: Callback, ms?: number, ...args: unknown[]): Timeout => this.add(fn, ms, args, true);
  setImmediate = (fn: Callback, ...args: unknown[]): Timeout => this.add(fn, 0, args, false);
  clearTimeout = (timer: unknown): void => this.clear(timer);
  clearInterval = (timer: unknown): void => this.clear(timer);
  clearImmediate = (timer: unknown): void => this.clear(timer);

  clear(timer: unknown): void {
    const id = typeof timer === 'object' && timer ? (timer as Timeout)._id : Number(timer);
    const t = this.timers.get(id);
    if (!t) return;
    this.disarm(t);
    this.timers.delete(id);
    t._destroyed = true;
    if (t._ref) {
      this.refTimers--;
      this.scheduleCheck();
    }
  }

  /** Has the loop been asked to check for idleness? Run the check after microtasks drain. */
  scheduleCheck(): void {
    if (this.checkScheduled || this.stopped) return;
    this.checkScheduled = true;
    // Two macrotask hops: a callback that schedules work via a just-resolved
    // promise gets every chance to register a timer or hold first.
    realSetTimeout(() => {
      realSetTimeout(() => {
        this.checkScheduled = false;
        if (!this.alive && !this.stopped) this.options.onIdle();
      }, 0);
    }, 0);
  }

  /** Stop everything: the process has exited. */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) this.disarm(t);
    this.timers.clear();
  }

  _refChanged(_t: Timeout, ref: boolean): void {
    this.refTimers += ref ? 1 : -1;
    if (!ref) this.scheduleCheck();
  }

  _arm(t: Timeout): void {
    this.disarm(t);
    const ms = Math.max(0, t._idleTimeout);
    if (t._repeat) t._handle = realSetInterval(() => t._fire(), Math.max(1, ms));
    else {
      t._handle = realSetTimeout(() => {
        this.timers.delete(t._id);
        t._destroyed = true;
        if (t._ref) this.refTimers--;
        t._fire();
        if (t._ref) this.scheduleCheck();
      }, ms);
    }
  }

  private add(fn: Callback, ms: number | undefined, args: unknown[], repeat: boolean): Timeout {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const t = new Timeout(this, fn, Number.isFinite(ms) ? Number(ms) : 1, args, repeat);
    if (this.stopped) return t;
    this.timers.set(t._id, t);
    this.refTimers++;
    this._arm(t);
    return t;
  }

  private disarm(t: Timeout): void {
    if (t._handle === undefined) return;
    if (t._repeat) realClearInterval(t._handle);
    else realClearTimeout(t._handle);
    t._handle = undefined;
  }
}
