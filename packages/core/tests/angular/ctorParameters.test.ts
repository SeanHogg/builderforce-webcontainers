import { describe, expect, it } from 'vitest';
import { addCtorParameters } from '../../src/angular/ctorParameters.js';

const FILE = '/src/app/x.ts';
const ctorParams = (out: string) => /static ctorParameters = \(\) => \[(.*?)\];/.exec(out)?.[1];

describe('addCtorParameters', () => {
  it('records plain, generic and qualified types, with parameter properties', () => {
    const out = addCtorParameters(
      `@Injectable({ providedIn: 'root' })\nexport class Store {\n  constructor(private http: HttpClient, public readonly cache: Map<string, Item>, protected ns: api.Client<A, B> = null!) {}\n}`,
      FILE,
    );
    expect(ctorParams(out)).toBe('{ type: HttpClient }, { type: Map }, { type: api.Client }');
    expect(out.split('\n')).toHaveLength(4);
  });

  it('carries parameter decorators, and @Inject leaves the type undefined', () => {
    const out = addCtorParameters(
      `@Component({ selector: 'x', template: '' })\nexport class X {\n  constructor(@Inject(CONFIG) cfg: AppConfig, @Optional() @Self() log: Logger, @Inject(forwardRef(() => Y)) y: Y, @Attribute('title') title: string) {}\n}`,
      FILE,
    );
    expect(ctorParams(out)).toBe(
      '{ type: undefined, decorators: [{ type: Inject, args: [CONFIG] }] }, ' +
        '{ type: Logger, decorators: [{ type: Optional, args: [] }, { type: Self, args: [] }] }, ' +
        '{ type: undefined, decorators: [{ type: Inject, args: [forwardRef(() => Y)] }] }, ' +
        "{ type: undefined, decorators: [{ type: Attribute, args: ['title'] }] }",
    );
  });

  it('leaves classes without constructor parameters, and undecorated classes, untouched', () => {
    const source = `@Component({ template: '' }) export class A { x = 1; }\n@Pipe({ name: 'p' }) export class B { constructor() {} }\nexport class C { constructor(d: D) {} }`;
    expect(addCtorParameters(source, FILE)).toBe(source);
  });

  it('skips constructor overloads and nested constructors', () => {
    const out = addCtorParameters(
      `@Injectable() export class S {\n  build() { return class { constructor(z: Z) {} }; }\n  constructor(a: A);\n  constructor(a: A) {}\n}`,
      FILE,
    );
    expect(ctorParams(out)).toBe('{ type: A }');
  });

  it('refuses a parameter with no injectable type, pointing at inject()', () => {
    for (const param of ['name: string', 'v: A | B', 'f: () => void', 'x', 'list: string[]']) {
      expect(() => addCtorParameters(`@Injectable() export class S { constructor(${param}) {} }`, FILE)).toThrow(
        /\/src\/app\/x\.ts: constructor parameter '\w+' of S has no injectable type\. Use @Inject\(TOKEN\) or switch to inject\(\) \(https:\/\/angular\.dev\/api\/core\/inject\)\./,
      );
    }
  });
});
