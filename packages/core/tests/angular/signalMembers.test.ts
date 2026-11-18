import { describe, expect, it } from 'vitest';
import { addSignalMemberDecorators } from '../../src/angular/signalMembers.js';

describe('addSignalMemberDecorators', () => {
  it('decorates signal inputs, models and outputs as Angular\'s JIT transform does', () => {
    const out = addSignalMemberDecorators(
      [
        `import { input, model, output } from '@angular/core'; import { outputFromObservable } from '@angular/core/rxjs-interop'; @Component({ selector: 'x', template: '' })`,
        'export class X {',
        '  name = input<string>();',
        "  readonly id = input.required<number>({ alias: 'itemId' });",
        "  size = input(0, { alias: 'sz', transform: numberAttribute });",
        '  value = model(0);',
        '  checked = model.required<boolean>();',
        '  changed = output<string>();',
        "  closed = output({ alias: 'close' });",
        "  ticks = outputFromObservable(interval(1000), { alias: 'tick' });",
        '  other = signal(input);',
        '  method() { const local = input(); }',
        '}',
      ].join('\n'),
    );
    expect(out.split('\n')[0]).toMatch(/^import \{ Input as ɵɵngJitInput, Output as ɵɵngJitOutput \} from '@angular\/core';import \{ input,/);
    expect(out).toContain('@ɵɵngJitInput({ isSignal: true, alias: "name", required: false, transform: undefined } as any) name = input<string>();');
    expect(out).toContain('@ɵɵngJitInput({ isSignal: true, alias: "itemId", required: true, transform: undefined } as any) readonly id');
    expect(out).toContain('alias: "sz", required: false');
    expect(out).toContain('@ɵɵngJitInput({ isSignal: true, alias: "value", required: false } as any) @ɵɵngJitOutput("valueChange") value = model(0);');
    expect(out).toContain('alias: "checked", required: true } as any) @ɵɵngJitOutput("checkedChange")');
    expect(out).toContain('@ɵɵngJitOutput("changed") changed');
    expect(out).toContain('@ɵɵngJitOutput("close") closed');
    expect(out).toContain('@ɵɵngJitOutput("tick") ticks');
    expect(out).toContain('  other = signal(input);');
    expect(out).toContain('const local = input();');
    expect(out.split('\n')).toHaveLength(13);
  });

  it('decorates signal queries with their locator and options', () => {
    const out = addSignalMemberDecorators(
      [
        `import { viewChild, viewChildren, contentChild, contentChildren } from '@angular/core'; @Directive({ selector: '[x]' })`,
        'export class X {',
        "  el = viewChild<ElementRef>('el');",
        '  req = viewChild.required(Child, { read: ElementRef });',
        '  all = viewChildren(Child);',
        '  projected = contentChild(Tpl, { descendants: true });',
        '  items = contentChildren(Item);',
        '}',
      ].join('\n'),
    );
    expect(out).toContain(`@ɵɵngJitViewChild('el', { isSignal: true } as any) el`);
    expect(out).toContain('@ɵɵngJitViewChild(Child, { ...{ read: ElementRef }, isSignal: true } as any) req');
    expect(out).toContain('@ɵɵngJitViewChildren(Child, { isSignal: true } as any) all');
    expect(out).toContain('@ɵɵngJitContentChild(Tpl, { ...{ descendants: true }, isSignal: true } as any) projected');
    expect(out).toContain('@ɵɵngJitContentChildren(Item, { isSignal: true } as any) items');
    expect(out).toMatch(/^import \{ ContentChild as ɵɵngJitContentChild, ContentChildren as ɵɵngJitContentChildren, ViewChild as ɵɵngJitViewChild, ViewChildren as ɵɵngJitViewChildren \}/);
  });

  it('leaves files without Angular classes or signal members alone', () => {
    const plain = `export const name = input();\nclass Y { a = input(); }`;
    expect(addSignalMemberDecorators(plain)).toBe(plain);
    const service = `@Injectable() export class S { a = input(); }`;
    expect(addSignalMemberDecorators(service)).toBe(service);
  });

  it('finds members in a class without semicolons, never decorating the field before', () => {
    const out = addSignalMemberDecorators(
      [
        `import { Component, ElementRef, input, output } from '@angular/core'`,
        `@Component({ selector: 'x', template: '' })`,
        'export class X {',
        '  foo = input<string>()',
        '  ref?: ElementRef',
        '  bar = input()',
        '  label: string | undefined =',
        "    input('x')",
        '  readonly done = output()',
        '  static s = input()',
        '}',
      ].join('\n'),
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[3]).toBe('  @ɵɵngJitInput({ isSignal: true, alias: "foo", required: false, transform: undefined } as any) foo = input<string>()');
    expect(lines[4]).toBe('  ref?: ElementRef');
    expect(lines[5]).toContain('alias: "bar"');
    expect(lines[5]).toMatch(/\) bar = input\(\)$/);
    expect(lines[6]).toMatch(/^ {2}@ɵɵngJitInput\(\{ isSignal: true, alias: "label".*\) label: string \| undefined =$/);
    expect(lines[8]).toBe('  @ɵɵngJitOutput("done") readonly done = output()');
    expect(lines[9]).toBe('  static s = input()');
  });

  it('resolves the functions through aliased and namespace imports from @angular/core', () => {
    const out = addSignalMemberDecorators(
      [
        `import { input as i, output as emit } from '@angular/core';`,
        `import * as ng from '@angular/core';`,
        `@Component({ selector: 'x', template: '' }) export class X {`,
        '  a = i<number>(0);',
        '  b = ng.input.required<string>();',
        '  c = emit();',
        '  d = ng.viewChild(Child);',
        '}',
      ].join('\n'),
    );
    expect(out).toContain('alias: "a", required: false, transform: undefined } as any) a = i<number>(0);');
    expect(out).toContain('alias: "b", required: true, transform: undefined } as any) b = ng.input.required');
    expect(out).toContain('@ɵɵngJitOutput("c") c = emit();');
    expect(out).toContain('@ɵɵngJitViewChild(Child, { isSignal: true } as any) d = ng.viewChild(Child);');
  });

  it('leaves a local function named input/output (not imported from Angular) untouched', () => {
    const source = [
      `import { Component } from '@angular/core';`,
      `import { output } from './my-signals';`,
      `function input<T>(): T | undefined { return undefined; }`,
      `@Component({ selector: 'x', template: '' }) export class X {`,
      '  a = input<string>();',
      '  b = output();',
      '}',
    ].join('\n');
    expect(addSignalMemberDecorators(source)).toBe(source);
  });
});
