import { describe, expect, it } from 'vitest';
import { addCtorParameters } from '../../src/angular/ctorParameters.js';

const CORE = `import { Attribute, Component, Inject, Injectable, Optional, Pipe, Self } from '@angular/core';\n`;
const ctorParams = (out: string) => /static ctorParameters = \(\) => \[(.*?)\];/.exec(out)?.[1];
const paramsOf = (param: string, imports = '') => ctorParams(addCtorParameters(`${imports}@Injectable() export class S { constructor(${param}) {} }`));

describe('addCtorParameters', () => {
  it('records plain, generic and qualified types, with parameter properties', () => {
    const out = addCtorParameters(
      `@Injectable({ providedIn: 'root' })\nexport class Store {\n  constructor(private http: HttpClient, public readonly cache: Map<string, Item>, protected ns: api.Client<A, B> = null!) {}\n}`,
    );
    expect(ctorParams(out)).toBe('{ type: HttpClient }, { type: Map }, { type: api.Client }');
    expect(out.split('\n')).toHaveLength(4);
  });

  it('carries Angular parameter decorators, and @Inject leaves the type undefined', () => {
    const out = addCtorParameters(
      `${CORE}@Component({ selector: 'x', template: '' })\nexport class X {\n  constructor(@Inject(CONFIG) cfg: AppConfig, @Optional() @Self() log: Logger, @Inject(forwardRef(() => Y)) y: Y, @Attribute('title') title: string) {}\n}`,
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
    expect(addCtorParameters(source)).toBe(source);
  });

  it('skips constructor overloads and nested constructors', () => {
    const out = addCtorParameters(`@Injectable() export class S {\n  build() { return class { constructor(z: Z) {} }; }\n  constructor(a: A);\n  constructor(a: A) {}\n}`);
    expect(ctorParams(out)).toBe('{ type: A }');
  });

  it("maps types the way Angular's downlevel transform does, never throwing", () => {
    expect(paramsOf('log: Logger | null')).toBe('{ type: Logger }');
    expect(paramsOf('log?: undefined | (Logger)')).toBe('{ type: Logger }');
    expect(paramsOf('name: string, n: number, b: boolean')).toBe('{ type: String }, { type: Number }, { type: Boolean }');
    expect(paramsOf('f: () => void, g: ((x: number) => string) | null')).toBe('{ type: Function }, { type: Function }');
    expect(paramsOf('list: string[], pair: [A, B], ro: readonly Item[]')).toBe('{ type: Array }, { type: Array }, { type: Array }');
    expect(paramsOf('m: Map<string, (x: A) => B>')).toBe('{ type: Map }');
    // No annotation, other unions, literals, object types: undefined — Angular raises NG0202 only if injected.
    expect(paramsOf("x, v: A | B, lit: 'a', t: true, o: { a: string }, u: unknown")).toBe(
      '{ type: undefined }, { type: undefined }, { type: undefined }, { type: undefined }, { type: undefined }, { type: undefined }',
    );
  });

  it('gives a type-only import undefined (it has no runtime value), unless @Inject names the token', () => {
    const imports = `import type { Config } from './config';\nimport { type Store, Http } from './deps';\nimport type * as api from './api';\n`;
    expect(paramsOf('cfg: Config, store: Store, http: Http, client: api.Client', imports)).toBe('{ type: undefined }, { type: undefined }, { type: Http }, { type: undefined }');
  });

  it("carries only @angular/core's parameter decorators — aliased or namespaced — and leaves others to TypeScript", () => {
    const out = addCtorParameters(
      [
        `import { Inject as In, Optional, Injectable } from '@angular/core';`,
        `import * as ng from '@angular/core';`,
        `import { Logged } from './logging';`,
        `@Injectable() export class S { constructor(@In(TOKEN) a: A, @ng.SkipSelf() @Logged() b: B, @Logged() c: C, @Optional() d: D | null) {} }`,
      ].join('\n'),
    );
    expect(ctorParams(out)).toBe(
      '{ type: undefined, decorators: [{ type: In, args: [TOKEN] }] }, ' +
        '{ type: B, decorators: [{ type: ng.SkipSelf, args: [] }] }, ' +
        '{ type: C }, ' +
        '{ type: D, decorators: [{ type: Optional, args: [] }] }',
    );
  });
});
