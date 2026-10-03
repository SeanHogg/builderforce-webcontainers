/**
 * `assert` (and `assert/strict`): the assertion functions test runners and
 * defensive library code call, throwing `AssertionError` with Node's fields.
 */
import { inspect } from './inspect.js';
import { isDeepStrictEqual } from './util.js';

export class AssertionError extends Error {
  code = 'ERR_ASSERTION';
  actual: unknown;
  expected: unknown;
  operator: string;
  generatedMessage: boolean;

  constructor(options: { message?: string | Error; actual?: unknown; expected?: unknown; operator?: string }) {
    const generated = options.message === undefined;
    super(generated ? `${inspect(options.actual)} ${options.operator ?? '=='} ${inspect(options.expected)}` : String(options.message));
    this.name = 'AssertionError';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? '==';
    this.generatedMessage = generated;
  }
}

function looseDeepEqual(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line eqeqeq
  if (a == b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => looseDeepEqual((a as any)[k], (b as any)[k]));
}

function fail(message: string | Error | undefined, actual: unknown, expected: unknown, operator: string): never {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message, actual, expected, operator });
}

function matchesExpectation(error: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected === 'function') {
    if (expected.prototype !== undefined && error instanceof (expected as new () => unknown)) return true;
    if (Error.isPrototypeOf(expected)) return false;
    return (expected as (e: unknown) => boolean)(error) === true;
  }
  if (expected instanceof RegExp) return expected.test(String(error instanceof Error ? error.message : error)) || expected.test(String(error));
  if (typeof expected === 'object' && expected) {
    return Object.entries(expected).every(([k, v]) => (v instanceof RegExp ? v.test(String((error as any)?.[k])) : isDeepStrictEqual((error as any)?.[k], v)));
  }
  return false;
}

export function createAssertModule(strict = false): Record<string, unknown> {
  const ok = (value: unknown, message?: string | Error) => {
    if (!value) fail(message ?? 'The expression evaluated to a falsy value', value, true, '==');
  };
  const equal = strict
    ? (a: unknown, b: unknown, m?: string | Error) => !Object.is(a, b) && fail(m, a, b, 'strictEqual')
    // eslint-disable-next-line eqeqeq
    : (a: unknown, b: unknown, m?: string | Error) => a != b && !(Number.isNaN(a) && Number.isNaN(b)) && fail(m, a, b, '==');
  const deepEqual = strict
    ? (a: unknown, b: unknown, m?: string | Error) => !isDeepStrictEqual(a, b) && fail(m, a, b, 'deepStrictEqual')
    : (a: unknown, b: unknown, m?: string | Error) => !looseDeepEqual(a, b) && fail(m, a, b, 'deepEqual');

  const throws = (fn: () => unknown, expected?: unknown, message?: string | Error) => {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
      fn();
    } catch (error) {
      if (!matchesExpectation(error, expected)) throw error;
      return;
    }
    fail(message ?? 'Missing expected exception.', undefined, expected, 'throws');
  };
  const rejects = async (promiseOrFn: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string | Error) => {
    if (typeof expected === 'string') [message, expected] = [expected, undefined];
    try {
      await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (error) {
      if (!matchesExpectation(error, expected)) throw error;
      return;
    }
    fail(message ?? 'Missing expected rejection.', undefined, expected, 'rejects');
  };

  const assert = ((value: unknown, message?: string | Error) => ok(value, message)) as ((value: unknown, message?: string | Error) => void) & Record<string, unknown>;
  Object.assign(assert, {
    ok,
    equal,
    notEqual: strict
      ? (a: unknown, b: unknown, m?: string | Error) => Object.is(a, b) && fail(m, a, b, 'notStrictEqual')
      // eslint-disable-next-line eqeqeq
      : (a: unknown, b: unknown, m?: string | Error) => a == b && fail(m, a, b, '!='),
    strictEqual: (a: unknown, b: unknown, m?: string | Error) => !Object.is(a, b) && fail(m, a, b, 'strictEqual'),
    notStrictEqual: (a: unknown, b: unknown, m?: string | Error) => Object.is(a, b) && fail(m, a, b, 'notStrictEqual'),
    deepEqual,
    notDeepEqual: (a: unknown, b: unknown, m?: string | Error) => (strict ? isDeepStrictEqual(a, b) : looseDeepEqual(a, b)) && fail(m, a, b, 'notDeepEqual'),
    deepStrictEqual: (a: unknown, b: unknown, m?: string | Error) => !isDeepStrictEqual(a, b) && fail(m, a, b, 'deepStrictEqual'),
    notDeepStrictEqual: (a: unknown, b: unknown, m?: string | Error) => isDeepStrictEqual(a, b) && fail(m, a, b, 'notDeepStrictEqual'),
    throws,
    doesNotThrow: (fn: () => unknown, message?: string | Error) => {
      try {
        fn();
      } catch (error) {
        fail(message ?? `Got unwanted exception: ${(error as Error)?.message ?? error}`, error, undefined, 'doesNotThrow');
      }
    },
    rejects,
    doesNotReject: async (p: Promise<unknown> | (() => Promise<unknown>), message?: string | Error) => {
      try {
        await (typeof p === 'function' ? p() : p);
      } catch (error) {
        fail(message ?? 'Got unwanted rejection.', error, undefined, 'doesNotReject');
      }
    },
    match: (s: string, re: RegExp, m?: string | Error) => !re.test(s) && fail(m ?? `The input did not match the regular expression ${re}. Input: ${inspect(s)}`, s, re, 'match'),
    doesNotMatch: (s: string, re: RegExp, m?: string | Error) => re.test(s) && fail(m, s, re, 'doesNotMatch'),
    ifError: (value: unknown) => {
      if (value !== null && value !== undefined) throw value;
    },
    fail: (message?: string | Error) => fail(message ?? 'Failed', undefined, undefined, 'fail'),
    AssertionError,
  });
  assert.strict = strict ? assert : createAssertModule(true);
  return assert;
}
