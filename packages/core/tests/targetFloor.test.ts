import { describe, expect, it } from 'vitest';
import { buildProject } from '../src/build.js';
import { readProjectConfig } from '../src/projectConfig.js';
import { targetAtLeast, TARGET_FLOOR } from '../src/transformer.js';
import { bundler, project, text, transformer } from './helpers.js';

/**
 * A tsconfig `target` applies only at or above the runtime's floors (es2020 per
 * module in dev, es2022 for a bundle): CRA's `es5` and Vite's `ES2017`/`ES2020`
 * must not lower code that worked before — top-level await in a build above all.
 */
const CRA_TSCONFIG = '{ "compilerOptions": { "target": "es5", "lib": ["dom", "esnext"], "jsx": "react-jsx" } }';

describe('tsconfig target floor', () => {
  it('raises a lower target to the floor and keeps a higher one', () => {
    expect(targetAtLeast('es2015', TARGET_FLOOR.transform)).toBe('es2020');
    expect(targetAtLeast('ES2017', TARGET_FLOOR.bundle)).toBe('es2022');
    expect(targetAtLeast('ES2022', TARGET_FLOOR.transform)).toBe('es2022');
    expect(targetAtLeast('esnext', TARGET_FLOOR.bundle)).toBe('esnext');
    expect(targetAtLeast(undefined, TARGET_FLOOR.bundle)).toBe('es2022');
  });

  it('dev: a CRA es5 tsconfig keeps es2020 output (optional chaining stays native)', async () => {
    const config = readProjectConfig(project({ 'tsconfig.json': CRA_TSCONFIG }));
    expect(config.typescript.target).toBe('es2015');
    const { code } = await transformer.transform('export const v = (globalThis as any).a?.b ?? 1;', {
      loader: 'ts',
      sourcefile: '/src/x.ts',
      define: {},
      jsx: config.jsx,
      typescript: config.typescript,
    });
    expect(code).toContain('?.b ?? 1');
  });

  it('build: a CRA es5 project with top-level await still builds (es2022)', async () => {
    const fs = project({
      'package.json': JSON.stringify({ dependencies: {} }),
      'tsconfig.json': CRA_TSCONFIG,
      'public/index.html': '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
      'src/index.ts': `const data = await Promise.resolve(42);\ndocument.getElementById('root')!.textContent = String(data);`,
    });
    const result = await buildProject({ files: fs, bundler, minify: false });
    const js = result.files.find((file) => /^assets\/index-.*\.js$/.test(file.path));
    expect(js && text(js.data)).toContain('await Promise.resolve(42)');
  });
});
