/**
 * Node's `util` module: formatting and inspection (inspect.ts), the classic
 * helpers (`inherits`, `promisify`, `deprecate`, `callbackify`), `types` and
 * `isDeepStrictEqual`.
 */
import { format, inspect } from './inspect.js';

export const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

export function promisify(fn: (...args: any[]) => unknown): (...args: any[]) => Promise<any> {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function');
  const custom = (fn as any)[promisifyCustom];
  if (typeof custom === 'function') return custom;
  function promisified(this: unknown, ...args: unknown[]) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (error: unknown, ...values: unknown[]) => {
        if (error) reject(error);
        else resolve(values.length > 1 ? values : values[0]);
      });
    });
  }
  Object.setPrototypeOf(promisified, Object.getPrototypeOf(fn));
  return Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(fn));
}
promisify.custom = promisifyCustom;

export function inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }): void {
  if (!superCtor?.prototype) throw new TypeError('The "superCtor.prototype" property must be of type object');
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function isDeepStrictEqual(a: unknown, b: unknown, seen = new Map<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (a instanceof Map) {
    const m = b as Map<unknown, unknown>;
    if (a.size !== m.size) return false;
    for (const [k, v] of a) if (!m.has(k) || !isDeepStrictEqual(v, m.get(k), seen)) return false;
    return true;
  }
  if (a instanceof Set) {
    const s = b as Set<unknown>;
    if (a.size !== s.size) return false;
    for (const v of a) if (!s.has(v) && ![...s].some((w) => isDeepStrictEqual(v, w, seen))) return false;
    return true;
  }
  if (ArrayBuffer.isView(a)) {
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && isDeepStrictEqual((a as any)[k], (b as any)[k], seen));
}

const tag = (v: unknown) => Object.prototype.toString.call(v).slice(8, -1);

export const types = {
  isPromise: (v: unknown) => v instanceof Promise,
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isWeakMap: (v: unknown) => v instanceof WeakMap,
  isWeakSet: (v: unknown) => v instanceof WeakSet,
  isNativeError: (v: unknown) => v instanceof Error,
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer || tag(v) === 'SharedArrayBuffer',
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isDataView: (v: unknown) => v instanceof DataView,
  isAsyncFunction: (v: unknown) => tag(v) === 'AsyncFunction' || tag(v) === 'AsyncGeneratorFunction',
  isGeneratorFunction: (v: unknown) => tag(v) === 'GeneratorFunction' || tag(v) === 'AsyncGeneratorFunction',
  isGeneratorObject: (v: unknown) => tag(v) === 'Generator',
  isBoxedPrimitive: (v: unknown) => v instanceof Number || v instanceof String || v instanceof Boolean,
  isProxy: () => false,
  isExternal: () => false,
  isModuleNamespaceObject: (v: unknown) => tag(v) === 'Module',
};

export function createUtilModule(env: () => Record<string, string | undefined>, warn: (message: string) => void): Record<string, unknown> {
  const warned = new Set<string>();
  return {
    format,
    formatWithOptions: (_options: unknown, ...args: unknown[]) => format(...args),
    inspect,
    inherits,
    promisify,
    callbackify(fn: (...args: any[]) => Promise<unknown>) {
      return function (this: unknown, ...args: any[]) {
        const callback = args.pop() as (error: unknown, value?: unknown) => void;
        fn.apply(this, args).then((value) => callback(null, value), (error) => callback(error ?? new Error('Promise was rejected with a falsy value')));
      };
    },
    deprecate<T extends (...args: any[]) => unknown>(fn: T, message: string, code?: string): T {
      return function (this: unknown, ...args: unknown[]) {
        const key = code ?? message;
        if (!warned.has(key)) {
          warned.add(key);
          warn(`(node) [${code ?? 'DEP'}] DeprecationWarning: ${message}`);
        }
        return fn.apply(this, args);
      } as T;
    },
    debuglog(section: string) {
      const enabled = new RegExp(`\\b${section}\\b`, 'i').test(env().NODE_DEBUG ?? '');
      const log = (...args: unknown[]) => enabled && warn(`${section.toUpperCase()}: ${format(...args)}`);
      log.enabled = enabled;
      return log;
    },
    isDeepStrictEqual: (a: unknown, b: unknown) => isDeepStrictEqual(a, b),
    types,
    TextEncoder,
    TextDecoder,
    stripVTControlCharacters: (s: string) => s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ''),
    styleText: (_style: unknown, text: string) => text,
    toUSVString: (s: string) => s.replace(/[\uD800-\uDFFF]/g, '�'),
    isArray: Array.isArray,
    isBoolean: (v: unknown) => typeof v === 'boolean',
    isNull: (v: unknown) => v === null,
    isNullOrUndefined: (v: unknown) => v == null,
    isNumber: (v: unknown) => typeof v === 'number',
    isString: (v: unknown) => typeof v === 'string',
    isSymbol: (v: unknown) => typeof v === 'symbol',
    isUndefined: (v: unknown) => v === undefined,
    isRegExp: types.isRegExp,
    isObject: (v: unknown) => v !== null && typeof v === 'object',
    isDate: types.isDate,
    isError: types.isNativeError,
    isFunction: (v: unknown) => typeof v === 'function',
    isPrimitive: (v: unknown) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
    isBuffer: (v: unknown) => (v as { constructor?: { name?: string } })?.constructor?.name === 'Buffer',
  };
}
