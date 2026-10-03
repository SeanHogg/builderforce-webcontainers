/**
 * Pre-ES2015 packages subclass Node's constructors the old way:
 *
 *     function MyStream(opts) { Readable.call(this, opts); }
 *     util.inherits(MyStream, Readable);
 *
 * Calling an ES class without `new` throws, so the shims we expose are plain
 * functions wrapping the class: `new`/`extends` construct the class, a bare
 * call runs its `init` on the caller's `this`. The prototype is shared, so
 * `instanceof` holds either way.
 */
export function callable<C extends abstract new (...args: any[]) => object>(Base: C, init: (self: any, ...args: any[]) => void): C {
  const Wrapped = function (this: unknown, ...args: unknown[]) {
    if (!new.target) {
      init(this, ...args);
      return this;
    }
    return Reflect.construct(Base, args, new.target);
  } as unknown as C;
  Object.defineProperty(Wrapped, 'name', { value: Base.name });
  (Wrapped as unknown as { prototype: object }).prototype = Base.prototype;
  Object.setPrototypeOf(Wrapped, Base); // statics
  Object.defineProperty(Base.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true, enumerable: false });
  return Wrapped;
}
