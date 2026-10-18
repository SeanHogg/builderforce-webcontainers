/**
 * A process's global object, as its code sees it (`global`, `globalThis`).
 *
 * - In a dedicated worker the real global object is the process's own: Node's
 *   names are installed on it.
 * - Where several processes share one realm (tests, the in-process kernel), each
 *   gets a view: its own names first, everything else read from the real global
 *   WITH the real one as receiver, because host getters (`crypto`, `navigator`)
 *   check what `this` is. Code the process compiles with `new Function` sees the
 *   same view (esbuild-wasm's launcher compiles Go's loader that way and the two
 *   hand `globalThis.Go` and `globalThis.crypto` to each other).
 *
 * Either way, assigning a global works as in Node. A browser's `crypto` (and a
 * host Node's) is a getter with no setter, so `globalThis.crypto = …` (Go's
 * WebAssembly loader, which esbuild-wasm runs) would throw in strict code; Node's
 * own globals let it replace the value.
 *
 * Adds `global` and `globalThis` to `globals` (and, for a view, `Function`), so
 * module code finds them in its outer scope. For a view it returns the `with`
 * scope module code is compiled in, so a bare name another module put on
 * `globalThis` (Go's loader sets `globalThis.fs`, then calls `fs.writeSync`)
 * resolves as it would on a real global.
 */
export function installGlobalObject(globals: Record<string, unknown>, installOnRealGlobal: boolean): object | undefined {
  makeAssignable(globalThis, ['crypto', 'performance', 'navigator']);
  if (installOnRealGlobal) {
    Object.assign(globalThis, globals, { global: globalThis });
    globals.global = globals.globalThis = globalThis;
    return undefined;
  }
  const own = Object.assign(Object.create(globalThis), globals) as Record<PropertyKey, unknown>;
  const view: Record<PropertyKey, unknown> = new Proxy(own, {
    get: (target, key) => (Object.hasOwn(target, key) ? target[key as string] : Reflect.get(globalThis, key)),
    // An assignment lands on this process's view: never on the shared real global, and
    // never refused by a getter-only accessor inherited from it.
    set: (target, key, value) => Reflect.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true }),
    // Redefining an inherited global without a value (`defineProperty(globalThis, 'crypto',
    // { writable: true })`) keeps the value it had, as it would on the real global.
    defineProperty: (target, key, descriptor) =>
      Reflect.defineProperty(target, key, Object.hasOwn(target, key) || 'value' in descriptor || descriptor.get || descriptor.set ? descriptor : { value: Reflect.get(globalThis, key), ...descriptor }),
  });
  // For `with`: claims only the view's own names, so everything else falls through to the real global.
  const scope = new Proxy(view, {
    has: (_target, key) => typeof key === 'string' && Object.hasOwn(own, key),
    get: (target, key) => (key === Symbol.unscopables ? undefined : Reflect.get(target, key)),
  });
  const scopedFunction = createScopedFunction(scope);
  own.global = own.globalThis = view;
  own.Function = scopedFunction;
  globals.global = globals.globalThis = view;
  globals.Function = scopedFunction;
  return scope;
}

/**
 * `Function` whose compiled code resolves free names through `scope` (the view's
 * own names, then the real global), as code compiled in a process's own realm would.
 */
function createScopedFunction(scope: object): FunctionConstructor {
  const compile = (args: unknown[]) => {
    const params = args.slice(0, -1).map(String).join(', ');
    const body = args.length ? String(args[args.length - 1]) : '';
    // Sloppy outer function: `with` routes free names through the view; the body may still be strict.
    return new Function('__bfwc_scope', `with (__bfwc_scope) { return function anonymous(${params}\n) {\n${body}\n}; }`)(scope);
  };
  return new Proxy(Function, { apply: (_target, _this, args) => compile(args), construct: (_target, args) => compile(args) });
}

/** Give each getter-only global (own or inherited) a writable own value, as Node's are. */
function makeAssignable(target: object, names: readonly string[]): void {
  for (const name of names) {
    let holder: object | null = target;
    let descriptor: PropertyDescriptor | undefined;
    while (holder && !(descriptor = Object.getOwnPropertyDescriptor(holder, name))) holder = Object.getPrototypeOf(holder);
    if (!descriptor || descriptor.set || 'value' in descriptor) continue;
    try {
      Object.defineProperty(target, name, { value: Reflect.get(target, name), writable: true, enumerable: true, configurable: true });
    } catch {
      // a non-configurable own accessor: leave it as the host made it
    }
  }
}
