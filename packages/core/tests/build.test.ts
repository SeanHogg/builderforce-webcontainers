import { beforeAll, describe, expect, it } from 'vitest';
import { buildProject, normalizeBase, type BuildResult } from '../src/build.js';
import { findHtmlEntries, rewriteBuiltHtml } from '../src/buildHtml.js';
import { bundler, components, project, text } from './helpers.js';

/** The generated Vite + React + TS shape, as in the dev server tests. */
function viteReactFiles(): Record<string, string | Uint8Array> {
  return {
    'package.json': JSON.stringify({
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { vite: '^5.4.0', typescript: '^5.5.0' },
    }),
    'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
    'tsconfig.app.json': '{ "compilerOptions": { "jsx": "react-jsx", "paths": { "@/*": ["./src/*"] } } }',
    '.env': 'VITE_TITLE=Hello',
    '.env.production': 'VITE_API=https://api.example.com',
    '.env.development': 'VITE_API=http://localhost:3000',
    'index.html': '<!doctype html><html><head><link rel="icon" href="/vite.svg"><title>t</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': [
      `import { createRoot } from 'react-dom/client';`,
      `import App from './App';`,
      `import './index.css';`,
      `createRoot(document.getElementById('root')!).render(<App />);`,
    ].join('\n'),
    'src/App.tsx': [
      `import { Button } from '@/components/Button';`,
      `import styles from './App.module.css';`,
      `import logo from './logo.svg';`,
      `import notes from './notes.md?raw';`,
      `const Lazy = () => import('./Lazy');`,
      `export default function App() { return <main className={styles.app}><img src={logo} /><Button label={import.meta.env.VITE_TITLE + import.meta.env.VITE_API + import.meta.env.MODE + notes} onClick={Lazy} /></main>; }`,
    ].join('\n'),
    'src/Lazy.tsx': `export default function Lazy() { return <p>lazy</p>; }`,
    'src/components/Button.tsx': `export function Button(p: { label: string; onClick?: () => void }) { return <button onClick={p.onClick}>{p.label}</button>; }`,
    'src/index.css': `body { background: url('./bg.png'); }`,
    'src/App.module.css': `.app { display: grid; }`,
    'src/bg.png': new Uint8Array([137, 80, 78, 71]),
    'src/logo.svg': '<svg/>',
    'src/notes.md': '# notes',
    'public/vite.svg': '<svg id="public"/>',
    'public/robots.txt': 'User-agent: *',
  };
}

function byPath(result: BuildResult): Map<string, string> {
  return new Map(result.files.map((file) => [file.path, text(file.data)]));
}

function find(files: Map<string, string>, pattern: RegExp): [string, string] {
  const hit = [...files].find(([path]) => pattern.test(path));
  if (!hit) throw new Error(`no output matching ${pattern} in ${[...files.keys()].join(', ')}`);
  return hit;
}

describe('buildProject on a Vite + React app', () => {
  let result: BuildResult;
  let files: Map<string, string>;
  let jsPath: string, js: string, cssPath: string, css: string, html: string;
  beforeAll(async () => {
    result = await buildProject({ files: viteReactFiles(), bundler, minify: false });
    files = byPath(result);
    [jsPath, js] = find(files, /^assets\/main-[A-Z0-9]+\.js$/);
    [cssPath, css] = find(files, /^assets\/main-[A-Z0-9]+\.css$/);
    html = files.get('index.html')!;
  });

  it('rewrites index.html to the hashed bundles, relative to a ./ base', () => {
    expect(html).toContain(`<script type="module" src="./${jsPath}"></script>`);
    expect(html).toContain(`<link rel="stylesheet" href="./${cssPath}">`);
    expect(html).not.toContain('/src/main.tsx');
    expect(html).toContain('href="./vite.svg"'); // public file rebased
    expect(html).not.toContain('bfwc:error'); // no dev-only scripts in a deployable page
  });

  it('bundles local modules and keeps packages on the CDN as pinned production URLs', () => {
    expect(js).not.toContain('<App />');
    expect(js).toContain('function Button');
    // A package carries only the pins it imports: react-dom pins react, and react
    // is the plain build react-dom links to, so there is one React.
    expect(js).toMatch(/from "https:\/\/esm\.sh\/react-dom@\^18\.3\.1\/client\?deps=react%40%5E18\.3\.1"/);
    expect(js).toContain('"https://esm.sh/react@^18.3.1/jsx-runtime"');
    expect(js).not.toMatch(/[?&]dev\b/);
  });

  it('inlines production env: import.meta.env, .env.production, MODE', () => {
    expect(js).toContain('Hello');
    expect(js).toContain('https://api.example.com');
    expect(js).not.toContain('localhost:3000');
    expect(js).toContain('production');
    expect(js).not.toContain('import.meta.env');
  });

  it('splits dynamic imports into their own chunk', () => {
    const [lazyPath] = find(files, /^assets\/Lazy-[A-Z0-9]+\.js$/);
    expect(js).toContain(`import("./${lazyPath.slice('assets/'.length)}")`);
  });

  it('extracts CSS, scopes CSS Modules, and hashes assets referenced from CSS and JS', () => {
    const [bgPath, bg] = find(files, /^assets\/bg-[0-9a-f]{8}\.png$/);
    expect(bg.length).toBe(4);
    expect(css).toMatch(new RegExp(`url\\("?\\./${bgPath.slice('assets/'.length).replace('.', '\\.')}"?\\)`));
    expect(css).toMatch(/\.App_app\w*\s*\{/);
    const [logoPath] = find(files, /^assets\/logo-[0-9a-f]{8}\.svg$/);
    expect(js).toContain(`new URL("./${logoPath.slice('assets/'.length)}", import.meta.url)`);
    expect(js).toContain('# notes'); // ?raw
  });

  it('copies public/ verbatim and lists files sorted', () => {
    expect(files.get('robots.txt')).toBe('User-agent: *');
    expect(files.get('vite.svg')).toBe('<svg id="public"/>');
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(result.profile).toMatchObject({ supported: true, kind: 'vite', framework: 'react' });
  });
});

describe('buildProject options and project kinds', () => {
  it('uses an absolute base verbatim for pages, assets and CSS', async () => {
    const files = byPath(await buildProject({ files: viteReactFiles(), bundler, base: '/app', minify: false }));
    const html = files.get('index.html')!;
    const [jsPath, js] = find(files, /^assets\/main-[A-Z0-9]+\.js$/);
    const [, css] = find(files, /^assets\/main-[A-Z0-9]+\.css$/);
    expect(html).toContain(`src="/app/${jsPath}"`);
    expect(html).toContain('href="/app/vite.svg"');
    expect(css).toMatch(/url\("?\/app\/assets\/bg-[0-9a-f]{8}\.png"?\)/);
    expect(js).toMatch(/"\/app\/assets\/logo-[0-9a-f]{8}\.svg"/);
  });

  it('minifies by default', async () => {
    const files = byPath(await buildProject({ files: viteReactFiles(), bundler }));
    const [, js] = find(files, /^assets\/main-[A-Z0-9]+\.js$/);
    expect(js).not.toContain('function Button(');
    expect(js.split('\n').length).toBeLessThan(10);
  });

  it('builds Create React App: entry injected, %PUBLIC_URL% filled, REACT_APP_ env inlined', async () => {
    const files = byPath(await buildProject({
      files: {
        'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-scripts': '5.0.1' } }),
        '.env': 'REACT_APP_NAME=Cra',
        'public/index.html': '<html><head><link rel="icon" href="%PUBLIC_URL%/favicon.ico"></head><body><div id="root"></div></body></html>',
        'public/favicon.ico': 'ico',
        'src/index.js': `import ReactDOM from 'react-dom/client';\nimport './index.css';\nReactDOM.createRoot(document.getElementById('root')).render(<h1>{process.env.REACT_APP_NAME}{process.env.NODE_ENV}{process.env.PUBLIC_URL}</h1>);`,
        'src/index.css': 'h1 { color: red }',
      },
      bundler,
      minify: false,
    }));
    const html = files.get('index.html')!;
    const [jsPath, js] = find(files, /^assets\/index-[A-Z0-9]+\.js$/);
    expect(html).toContain('href="./favicon.ico"');
    expect(html).toContain(`<script type="module" src="./${jsPath}"></script>`);
    expect(html).toMatch(/<link rel="stylesheet" href="\.\/assets\/index-[A-Z0-9]+\.css">\n<\/head>/);
    expect(js).toContain('"Cra"');
    expect(js).toContain('"production"');
    expect(files.get('favicon.ico')).toBe('ico');
    expect(files.has('public/index.html')).toBe(false);
  });

  it('builds a static site with a stylesheet entry and a package stylesheet import', async () => {
    const files = byPath(await buildProject({
      files: {
        'package.json': JSON.stringify({ dependencies: { bootstrap: '^5.3.0' } }),
        'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body><script type="module" src="./app.js"></script></body></html>',
        'style.css': 'body { margin: 0; background: url(icons.svg#dot) }',
        'icons.svg': '<svg/>',
        'app.js': `import 'bootstrap/dist/css/bootstrap.min.css';\ndocument.body.append('hi');`,
      },
      bundler,
      minify: false,
    }));
    const html = files.get('index.html')!;
    const [stylePath, style] = find(files, /^assets\/style-[A-Z0-9]+\.css$/);
    const [, appCss] = find(files, /^assets\/app-[A-Z0-9]+\.css$/);
    expect(html).toContain(`href="./${stylePath}"`);
    expect(style).toContain('margin: 0');
    expect(style).toMatch(/url\("?\.\/icons-[0-9a-f]{8}\.svg#dot"?\)/); // relative CSS url, fragment kept
    expect(appCss).toMatch(/@import "https:\/\/esm\.sh\/bootstrap@\^5\.3\.0\/dist\/css\/bootstrap\.min\.css/);
  });

  it('builds a Vite + Vue app with scoped component CSS in the bundle', async () => {
    const files = byPath(await buildProject({
      files: {
        'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' }, devDependencies: { vite: '^5.4.0' } }),
        'index.html': '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
        'src/main.ts': `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`,
        'src/App.vue': `<script setup lang="ts">\nimport { ref } from 'vue';\nconst n = ref<number>(1);\n</script>\n<template><p class="a">{{ n }}</p></template>\n<style scoped>.a { color: red }</style>`,
      },
      bundler,
      components,
      minify: false,
    }));
    const [, js] = find(files, /^assets\/main-[A-Z0-9]+\.js$/);
    const [cssPath, css] = find(files, /^assets\/main-[A-Z0-9]+\.css$/);
    expect(js).toMatch(/from "https:\/\/esm\.sh\/vue@\^3\.5\.0[?"]/);
    expect(js).not.toContain('ref<number>');
    expect(js).toMatch(/data-v-[0-9a-f]{8}/);
    expect(css).toMatch(/\.a\[data-v-[0-9a-f]{8}\]/);
    expect(files.get('index.html')).toContain(`href="./${cssPath}"`);
  });

  it('builds a Vite + Svelte app with component CSS extracted', async () => {
    const files = byPath(await buildProject({
      files: {
        'package.json': JSON.stringify({ devDependencies: { svelte: '^5.0.0', vite: '^5.4.0' } }),
        'index.html': '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
        'src/main.ts': `import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('app')! });`,
        'src/App.svelte': `<script lang="ts">let n: number = $state(1);</script><h1>{n}</h1><style>h1 { color: blue }</style>`,
      },
      bundler,
      components,
      minify: false,
    }));
    const [, js] = find(files, /^assets\/main-[A-Z0-9]+\.js$/);
    const [, css] = find(files, /^assets\/main-[A-Z0-9]+\.css$/);
    expect(js).toMatch(/"https:\/\/esm\.sh\/svelte@\^5\.0\.0\/internal\/client/);
    expect(js).toMatch(/"https:\/\/esm\.sh\/svelte@\^5\.0\.0\?deps=|"https:\/\/esm\.sh\/svelte@\^5\.0\.0"/);
    expect(css).toMatch(/h1\.svelte-[a-z0-9]+/);
  });

  it('refuses projects it cannot build, with the reason', async () => {
    await expect(buildProject({ files: { 'package.json': '{"dependencies":{"next":"14"}}', 'index.html': '' }, bundler })).rejects.toThrow(/Next\.js/);
  });

  it('reports an unresolvable import as a build error', async () => {
    await expect(buildProject({ files: { 'index.html': '<script type="module" src="/main.js"></script>', 'main.js': `import './missing.js';` }, bundler }))
      .rejects.toThrow(/Cannot resolve "\.\/missing\.js"/);
  });
});

describe('build HTML helpers', () => {
  it('normalises the base', () => {
    expect(normalizeBase(undefined)).toBe('./');
    expect(normalizeBase('.')).toBe('./');
    expect(normalizeBase('/app')).toBe('/app/');
    expect(normalizeBase('https://cdn.example.com/x/')).toBe('https://cdn.example.com/x/');
  });

  it('finds only local module scripts and stylesheets', () => {
    const fs = project({ 'src/main.ts': '', 'a.css': '' });
    const html = '<script src="/src/main.ts"></script><script type="module" src="/src/main.ts"></script><script type="module" src="https://x.com/a.js"></script><link rel="stylesheet" href="a.css"><link rel="icon" href="a.css">';
    expect(findHtmlEntries(fs, html, '/index.html')).toEqual([
      { tag: 'script', url: '/src/main.ts', path: '/src/main.ts' },
      { tag: 'style', url: 'a.css', path: '/a.css' },
    ]);
  });

  it('adds stylesheets to a page without a head', () => {
    const out = rewriteBuiltHtml('<script type="module" src="/m.ts"></script>', {
      base: './',
      entries: [{ tag: 'script', url: '/m.ts', path: '/m.ts' }],
      outputs: { '/m.ts': { js: 'assets/m-1.js', css: 'assets/m-1.css' } },
    });
    expect(out).toBe('<script type="module" src="./assets/m-1.js"></script><link rel="stylesheet" href="./assets/m-1.css">');
  });
});
