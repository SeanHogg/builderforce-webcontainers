import { describe, expect, it } from 'vitest';
import { createAngularCompiler } from '../../src/angular/compiler.js';
import { transformer } from '../helpers.js';

/**
 * The Angular compiler's output, through the real esbuild transformer with the
 * TypeScript options it asks for, evaluated against stub decorators: proves the
 * legacy decorators, `[[Set]]` fields and ctorParameters exist at runtime.
 */
async function evaluate(source: string, zone: boolean): Promise<{ code: string; exports: Record<string, any> }> {
  const compiled = await createAngularCompiler({ zone }).compile(source, { path: '/src/app/x.ts', dev: true });
  expect(compiled.typescript).toMatchObject({ experimentalDecorators: true, useDefineForClassFields: false });
  const { code } = await transformer.transform(compiled.code, {
    loader: compiled.loader,
    sourcefile: '/src/app/x.ts',
    define: {},
    jsx: { runtime: 'automatic', importSource: 'react' },
    typescript: compiled.typescript,
  });
  const recorded: Record<string, any> = {};
  const stubs = {
    Component: (meta: object) => (cls: any) => { cls.meta = meta; return cls; },
    Injectable: () => (cls: any) => cls,
    Inject: (token: unknown) => () => { recorded.injectToken = token; },
    Optional: () => () => {},
    ɵɵngJitInput: (options: object) => (proto: any, key: string) => { (proto.constructor.inputs ??= {})[key] = options; },
    TOKEN: 'TOKEN',
  };
  const body = code
    .replace(/^import[^;]*;/gm, '')
    .replace(/^export \{[^}]*\};?$/gm, '')
    .replace(/\/\/# sourceMappingURL=.*$/m, '');
  const names = ['Svc', 'Base', 'X'];
  const factory = new Function(...Object.keys(stubs), `${body}\nreturn { ${names.join(', ')} };`);
  return { code, exports: { ...factory(...Object.values(stubs)), recorded } };
}

const SOURCE = [
  `@Injectable() class Svc { async load() { await Promise.resolve(); return 1; } }`,
  `class Base { set value(v: number) { (this as any).seen = v; } }`,
  `@Component({ selector: 'x', template: '<p></p>' })`,
  `class X extends Base {`,
  `  value = 1;`,
  `  name = input<string>();`,
  `  constructor(private svc: Svc, @Optional() @Inject(TOKEN) private cfg: Config) { super(); }`,
  `}`,
  `function input<T>(): T | undefined { return undefined; }`,
].join('\n');

describe('Angular decorator lowering', () => {
  it('emits legacy decorators, [[Set]] class fields and ctorParameters', async () => {
    const { exports } = await evaluate(SOURCE, false);
    const { X, Svc } = exports;
    expect(X.meta).toEqual({ selector: 'x', template: '<p></p>' });
    expect(X.inputs.name).toEqual({ isSignal: true, alias: 'name', required: false, transform: undefined });
    expect(new X(new Svc(), 'c').seen).toBe(1); // a field assignment runs the inherited setter
    const params = X.ctorParameters();
    expect(params[0]).toEqual({ type: Svc });
    expect(params[1].type).toBeUndefined();
    expect(params[1].decorators.map((d: any) => d.args)).toEqual([[], ['TOKEN']]);
  });

  it('lowers async/await for zone.js apps only', async () => {
    const zoned = await evaluate(SOURCE, true);
    expect(zoned.code).not.toMatch(/\basync\b|\bawait\b/);
    expect(await new zoned.exports.Svc().load()).toBe(1);
    const zoneless = await evaluate(SOURCE, false);
    expect(zoneless.code).toMatch(/async load\(\)/);
  });
});
