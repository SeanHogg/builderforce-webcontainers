import { describe, expect, it } from 'vitest';
import { DevServer } from '../src/devServer.js';
import { buildProject } from '../src/build.js';
import { scopeCssModule } from '../src/styles/cssModules.js';
import type { PackageCdnFactory } from '../src/packageCdn.js';
import { bundler, components, project, styles, text, transformer } from './helpers.js';

const BASE = '/__bfwc/p1/';
const cdn: PackageCdnFactory = () => ({ urlFor: (name, subpath) => `https://cdn.test/${name}${subpath}` });
const offline = { fetchText: async () => undefined };

function app(files: Record<string, string>) {
  return project({
    'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0' } }),
    'index.html': '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': `import './index.css';`,
    'src/index.css': 'body { margin: 0; }',
    ...files,
  });
}

function server(fs = app({}), extra: Partial<ConstructorParameters<typeof DevServer>[0]> = {}) {
  return new DevServer({ fs, transformer, base: BASE, cdn, components, styles, styleImports: offline, ...extra });
}

describe('CSS Modules scoping', () => {
  it('renames classes per file and leaves :global ones alone', () => {
    const { css, locals } = scopeCssModule('.title { color: red } :global(.reset) .title:hover {} .a, :global .b .c {}', '/src/Card.module.css');
    expect(locals.title).toMatch(/^_title_[0-9a-f]{5}$/);
    expect(css).toContain(`.${locals.title} {`);
    expect(css).toContain(`.reset .${locals.title}:hover`);
    expect(css).toContain(`.${locals.a}, .b .c`);
    expect(locals).not.toHaveProperty('reset');
    expect(locals).not.toHaveProperty('b');
    expect(scopeCssModule('.title{}', '/src/Other.module.css').locals.title).not.toBe(locals.title);
  });

  it('is stable across edits, so an open page keeps its class names', () => {
    expect(scopeCssModule('.x { color: red }', '/a.module.css').locals.x).toBe(scopeCssModule('.x { color: blue } .y {}', '/a.module.css').locals.x);
  });

  it('records composes and drops the declaration', () => {
    const { css, composes } = scopeCssModule(
      `.base { padding: 0 } .button { composes: base; composes: focus from global; composes: shadow from './shared.module.css'; color: red }`,
      '/b.module.css',
    );
    expect(css).not.toContain('composes');
    expect(composes.button).toEqual([
      { kind: 'local', name: 'base' },
      { kind: 'global', name: 'focus' },
      { kind: 'import', from: './shared.module.css', name: 'shadow' },
    ]);
  });

  it('scopes local keyframes and the animations that use them', () => {
    const { css, locals } = scopeCssModule('@keyframes spin { from { opacity: 0 } } .s { animation: spin 1s linear; animation-name: spin, fade }', '/k.module.css');
    expect(css).toContain(`@keyframes ${locals.spin} {`);
    expect(css).toContain(`animation: ${locals.spin} 1s linear;`);
    expect(css).toContain(`animation-name: ${locals.spin}, fade`);
  });

  it('handles nested rules, at-rules and characters inside url()', () => {
    const { css, locals } = scopeCssModule(
      `@media (min-width: 600px) { .wide { background: url(data:image/svg+xml;utf8,<svg></svg>) } } .card { & .inner { color: red } }`,
      '/n.module.css',
    );
    expect(css).toContain(`.${locals.wide} {`);
    expect(css).toContain('url(data:image/svg+xml;utf8,<svg></svg>)');
    expect(css).toContain(`& .${locals.inner}`);
  });
});

describe('dev server stylesheets', () => {
  it('serves a CSS Module with scoped CSS and its class map', async () => {
    const fs = app({
      'src/Card.module.css': `.title { color: red } .big { composes: title; font-size: 2em }`,
      'src/main.tsx': `import styles from './Card.module.css'; console.log(styles.title);`,
    });
    const main = text((await server(fs).handle('/src/main.tsx')).body);
    expect(main).toContain(`${BASE}src/Card.module.css?import`);
    const module = text((await server(fs).handle('/src/Card.module.css', '?import')).body);
    expect(module).toMatch(/"title": "_title_[0-9a-f]{5}"/);
    expect(module).toMatch(/"big": "_big_[0-9a-f]{5}" \+ " " \+ "_title_[0-9a-f]{5}"/);
    expect(module).toContain('export default __classes;');
    expect(module).toContain('export const title = __classes["title"];');
    expect(module).toContain('data-bfwc');
  });

  it('imports a composed class from another CSS Module', async () => {
    const fs = app({
      'src/shared.module.css': '.shadow { box-shadow: 0 0 1px }',
      'src/Button.module.css': `.button { composes: shadow from './shared.module.css'; }`,
    });
    const module = text((await server(fs).handle('/src/Button.module.css', '?import')).body);
    expect(module).toContain(`import __composed0 from "${BASE}src/shared.module.css?import";`);
    expect(module).toContain('__composed0["shadow"]');
  });

  it('compiles Sass with partials, as a module and as CSS', async () => {
    const fs = app({
      'src/styles/_vars.scss': '$brand: #336699;',
      'src/styles/app.scss': `@use 'vars'; .app { color: vars.$brand; .inner { margin: 0 } }`,
      'src/main.tsx': `import './styles/app.scss';`,
    });
    const s = server(fs);
    expect(text((await s.handle('/src/main.tsx')).body)).toContain(`${BASE}src/styles/app.scss?import`);
    const module = text((await s.handle('/src/styles/app.scss', '?import')).body);
    expect(module).toContain('#336699');
    expect(module).toContain('.app .inner');
    const css = await s.handle('/src/styles/app.scss');
    expect(css.headers['content-type']).toMatch(/text\/css/);
    expect(text(css.body)).toContain('color: #336699');
  });

  it('scopes a Sass CSS Module', async () => {
    const fs = app({ 'src/Card.module.scss': '$pad: 4px; .card { padding: $pad; }' });
    const module = text((await server(fs).handle('/src/Card.module.scss', '?import')).body);
    expect(module).toMatch(/_card_[0-9a-f]{5}/);
    expect(module).toContain('padding: 4px');
  });

  it('compiles Less with imports', async () => {
    const fs = app({ 'src/theme.less': '@accent: #ff0000;', 'src/app.less': `@import './theme'; .a { color: @accent; }` });
    expect(text((await server(fs).handle('/src/app.less', '?import')).body)).toContain('color: #ff0000');
  });

  it('reports a Sass error as a module that throws, naming the file', async () => {
    const fs = app({ 'src/bad.scss': '.a { color: $missing; }' });
    const body = text((await server(fs).handle('/src/bad.scss', '?import')).body);
    expect(body).toMatch(/^throw new Error/);
    expect(body).toContain('/src/bad.scss');
  });

  it('links a package stylesheet imported from JS', async () => {
    const fs = app({ 'src/main.tsx': `import 'bootstrap/dist/css/bootstrap.css';` });
    const s = server(fs);
    const main = text((await s.handle('/src/main.tsx')).body);
    expect(main).toContain(`${BASE}bfwc-package-css/bootstrap/dist/css/bootstrap.css`);
    const linked = text((await s.handle('/bfwc-package-css/bootstrap/dist/css/bootstrap.css')).body);
    expect(linked).toContain(`link.href = "https://cdn.test/bootstrap/dist/css/bootstrap.css"`);
  });

  it('compiles an installed package Sass entry and its partials', async () => {
    const fs = app({
      'node_modules/kit/scss/_tokens.scss': '$gap: 8px;',
      'node_modules/kit/scss/kit.scss': `@use 'tokens'; .kit { gap: tokens.$gap; }`,
      'src/main.tsx': `import 'kit/scss/kit.scss';`,
    });
    expect(text((await server(fs).handle('/bfwc-package-css/kit/scss/kit.scss')).body)).toContain('gap: 8px');
  });

  it('fetches a package Sass partial from the CDN when it is not installed', async () => {
    const files: Record<string, string> = { 'https://cdn.jsdelivr.net/npm/kit@latest/scss/_tokens.scss': '$gap: 3px;' };
    const fs = app({ 'src/app.scss': `@use 'kit/scss/tokens'; .a { gap: tokens.$gap; }` });
    const s = server(fs, { styleImports: { fetchText: async (url) => files[url] } });
    expect(text((await s.handle('/src/app.scss', '?import')).body)).toContain('gap: 3px');
  });

  it('points relative and package @imports where the preview can load them', async () => {
    const fs = app({ 'src/base.css': 'a {}', 'src/index.css': `@import './base.css'; @import '~normalize.css/normalize.css'; body {}` });
    const module = text((await server(fs).handle('/src/index.css', '?import')).body);
    expect(module).toContain(`@import url(\\"${BASE}src/base.css\\")`);
    expect(module).toContain('@import url(\\"https://cdn.test/normalize.css/normalize.css\\")');
  });
});

describe('component <style lang>', () => {
  it('compiles a scoped Sass block in a Vue component', async () => {
    const fs = project({
      'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' }, devDependencies: { vite: '^5.4.0' } }),
      'index.html': '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': '',
      'src/App.vue': `<template><p class="a">hi</p></template>\n<style lang="scss" scoped>\n$c: green; .a { color: $c; }\n</style>`,
    });
    const body = text((await server(fs).handle('/src/App.vue')).body);
    expect(body).toMatch(/\.a\[data-v-[0-9a-f]+\]/);
    expect(body).toContain('color: green');
  });

  it('compiles a Less block in a Svelte component', async () => {
    const fs = project({
      'package.json': JSON.stringify({ dependencies: { svelte: '^5.0.0' }, devDependencies: { vite: '^5.4.0' } }),
      'index.html': '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': '',
      'src/App.svelte': `<p class="a">hi</p>\n<style lang="less">@c: blue; .a { color: @c; }</style>`,
    });
    expect(text((await server(fs).handle('/src/App.svelte')).body)).toContain('color: blue');
  });
});

describe('build stylesheets', () => {
  it('compiles Sass, scopes a Sass CSS Module and bundles a package Sass entry', async () => {
    const result = await buildProject({
      files: {
        'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0' } }),
        'index.html': '<!doctype html><html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
        'src/main.ts': `import './app.scss'; import styles from './Card.module.scss'; import 'kit/scss/kit.scss'; console.log(styles.card);`,
        'src/_vars.scss': '$brand: #123456;',
        'src/app.scss': `@use 'vars'; body { color: vars.$brand; }`,
        'src/Card.module.scss': '.card { padding: 2px; }',
        'node_modules/kit/scss/kit.scss': '.kit { gap: 1px; }',
      },
      bundler,
      cdn,
      styles,
      styleImports: offline,
      minify: false,
    });
    const css = result.files.filter((file) => file.path.endsWith('.css')).map((file) => new TextDecoder().decode(file.data)).join('\n');
    expect(css).toContain('#123456');
    expect(css).toMatch(/\.[\w-]*card[\w-]*\s*\{\s*padding: 2px/);
    expect(css).not.toMatch(/\.card\s*\{/);
    expect(css).toContain('gap: 1px');
  });
});
