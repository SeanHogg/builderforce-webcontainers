/**
 * Node's EventEmitter. Most of the Node API surface (streams, servers, child
 * processes, `process` itself) is built on it, so it is written faithfully:
 * listener order, `once` wrappers that `removeListener` can find, the throw on
 * an unhandled `'error'`, and `newListener`/`removeListener` events.
 */

import { callable } from './callable.js';

export type Listener = (...args: any[]) => unknown;
interface OnceWrapper extends Listener {
  listener: Listener;
}

/** The class itself, for subclassing inside the runtime; user code gets {@link EventEmitter}. */
export class EventEmitterBase {
  static defaultMaxListeners = 10;
  static readonly errorMonitor = Symbol('events.errorMonitor');
  // `declare`: no class-field initialiser, so a bare `EventEmitter.call(this)` and
  // `new` set up the same state (see callable.ts).
  declare _events: Map<string | symbol, Listener[]>;
  declare _maxListeners?: number;

  constructor() {
    initEmitter(this);
  }

  /** Resolve with the arguments of the next `event` (rejects on `'error'`). */
  static once(emitter: EventEmitterBase, event: string | symbol): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const onError = (error: unknown) => {
        emitter.removeListener(event, onEvent);
        reject(error);
      };
      const onEvent = (...args: unknown[]) => {
        if (event !== 'error') emitter.removeListener('error', onError);
        resolve(args);
      };
      emitter.once(event, onEvent);
      if (event !== 'error') emitter.once('error', onError);
    });
  }

  static listenerCount(emitter: EventEmitterBase, event: string | symbol): number {
    return emitter.listenerCount(event);
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false);
  }

  on(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false);
  }

  prependListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, true);
  }

  once(event: string | symbol, listener: Listener): this {
    return this._add(event, this._onceWrap(event, listener), false);
  }

  prependOnceListener(event: string | symbol, listener: Listener): this {
    return this._add(event, this._onceWrap(event, listener), true);
  }

  removeListener(event: string | symbol, listener: Listener): this {
    const list = this._events?.get(event);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i]!;
      if (entry === listener || (entry as OnceWrapper).listener === listener) {
        list.splice(i, 1);
        if (!list.length) this._events.delete(event);
        if (this._events.has('removeListener')) this.emit('removeListener', event, listener);
        break;
      }
    }
    return this;
  }

  off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (!this._events) return this;
    if (event === undefined) this._events.clear();
    else this._events.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this._events?.get(event);
    if (event === 'error') {
      this._events?.get(EventEmitterBase.errorMonitor)?.slice().forEach((l) => l.apply(this, args));
      if (!list?.length) {
        const error = args[0];
        if (error instanceof Error) throw error;
        const wrapped = new Error(`Unhandled error. (${String(error)})`) as Error & { context?: unknown };
        wrapped.context = error;
        throw wrapped;
      }
    }
    if (!list?.length) return false;
    for (const listener of list.slice()) listener.apply(this, args);
    return true;
  }

  listeners(event: string | symbol): Listener[] {
    return (this._events?.get(event) ?? []).map((l) => (l as OnceWrapper).listener ?? l);
  }

  rawListeners(event: string | symbol): Listener[] {
    return [...(this._events?.get(event) ?? [])];
  }

  listenerCount(event: string | symbol): number {
    return this._events?.get(event)?.length ?? 0;
  }

  eventNames(): Array<string | symbol> {
    return [...(this._events?.keys() ?? [])];
  }

  setMaxListeners(n: number): this {
    this._maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this._maxListeners ?? EventEmitterBase.defaultMaxListeners;
  }

  private _add(event: string | symbol, listener: Listener, prepend: boolean): this {
    if (typeof listener !== 'function') throw new TypeError('The "listener" argument must be of type function');
    // Subclasses created with util.inherits + EventEmitter.call(this) arrive here
    // without the constructor's field initialisers having run on them.
    if (!this._events) this._events = new Map();
    if (this._events.has('newListener')) this.emit('newListener', event, (listener as OnceWrapper).listener ?? listener);
    const list = this._events.get(event) ?? [];
    if (prepend) list.unshift(listener);
    else list.push(listener);
    this._events.set(event, list);
    return this;
  }

  private _onceWrap(event: string | symbol, listener: Listener): OnceWrapper {
    let fired = false;
    const wrapper = ((...args: unknown[]) => {
      if (fired) return undefined;
      fired = true;
      this.removeListener(event, wrapper);
      return listener.apply(this, args);
    }) as OnceWrapper;
    wrapper.listener = listener;
    return wrapper;
  }
}

function initEmitter(self: { _events?: Map<string | symbol, Listener[]> }): void {
  if (!self._events || !(self._events instanceof Map)) self._events = new Map();
}

export const EventEmitter = callable(EventEmitterBase, initEmitter);
export type EventEmitter = EventEmitterBase;

/** The `events` module object: the class, with Node's statics hung on it. */
export function createEventsModule(): Record<string, unknown> {
  const mod = EventEmitter as unknown as Record<string, unknown>;
  mod.EventEmitter = EventEmitter;
  mod.once = EventEmitterBase.once;
  mod.defaultMaxListeners = EventEmitterBase.defaultMaxListeners;
  return mod;
}
