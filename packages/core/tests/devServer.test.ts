import { describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { VirtualFileSystem } from '../src/vfs.js';
import { DevServer } from '../src/devServer.js';
import { createEsbuildTransformer } from '../src/transformer.js';

const BASE = '/__bfwc/p1/';

/** A typical generated Vite + React + TS app, the shape the canvas produces. */
function viteReactApp(): VirtualFileSystem {
  const fs = new VirtualFileSystem();
  fs.mount({
    'package.json': JSON.stringify({
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
      devDependencies: { vite: '^5.4.0', typescript: '^5.5.0' },
    }),
    'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx", "paths": { "@/*": ["./src/*"] } } }',
    '.env': 'VITE_TITLE=Hello',
    'index.html': '<!doctype html><html><head><title>t</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': [
      `import React from 'react';`,
      `import { createRoot } from 'react-dom/client';`,
      `import App from './App';`,
      `import './index.css';`,
      `createRoot(document.getElementById('root')!).render(<App />);`,
    ].join('\n'),
    'src/App.tsx': [
      `import { Button } from '@/components/Button';`,
      `import data from './data.json';`,
      `import logo from './logo.svg';`,
      `import readme from './notes.md?raw';`,
      `export default function App() { return <main><img src={logo} /><Button label={import.meta.env.VITE_TITLE + data.n + readme} /></main>; }`,
    ].join('\n'),
    'src/components/Button.tsx': `export function Button(p: { label: string }) { return <button>{p.label}</button>; }`,
    'src/index.css': `body { background: url('./bg.png'); }`,
    'src/bg.png': new Uint8Array([137, 80, 78, 71]),
    'src/data.json': '{ "n": 1 }',
    'src/logo.svg': '<svg/>',
    'src/notes.md': '# notes',
    'public/robots.txt': 'User-agent: *',
  });
  return fs;
}

function server(fs = viteReactApp()): DevServer {
  return new DevServer({ fs, transformer: createEsbuildTransformer(esbuild), base: BASE });
}

const text = (body: string | Uint8Array) => (typeof body === 'string' ? body : new TextDecoder().decode(body));

describe('DevServer on a Vite + React app', () => {
  it('serves the document with the entry re-rooted and the error bridge', async () => {
    const res = await server().handle('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(text(res.body)).toContain(`src="${BASE}src/main.tsx"`);
    expect(text(res.body)).toContain('bfwc:error');
  });

  it('compiles TSX and maps packages to the CDN, local files to preview URLs', async () => {
    const res = await server().handle('/src/main.tsx');
    const js = text(res.body);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(js).not.toContain('<App />');
    expect(js).toMatch(/https:\/\/esm\.sh\/react-dom@\^18\.3\.1\/client\?deps=/);
    expect(js).toMatch(/https:\/\/esm\.sh\/react@\^18\.3\.1\/jsx-runtime/);
    expect(js).toContain(`${BASE}src/App.tsx`);
    expect(js).toContain(`${BASE}src/index.css?import`);
  });

  it('resolves aliases, JSON, asset URLs, ?raw and import.meta.env', async () => {
    const js = text((await server().handle('/src/App.tsx')).body);
    expect(js).toContain(`${BASE}src/components/Button.tsx`);
    expect(js).toContain(`${BASE}src/data.json?import`);
    expect(js).toContain(`${BASE}src/logo.svg?url`);
    expect(js).toContain(`${BASE}src/notes.md?raw`);
    expect(js).toContain('"Hello"');
  });

  it('wraps CSS as an injecting module with document-safe url() references', async () => {
    const js = text((await server().handle('/src/index.css', '?import')).body);
    expect(js).toContain(`data-bfwc`);
    expect(js).toContain(`url('${BASE}src/bg.png')`);
  });

  it('serves the JSON, URL and raw wrappers', async () => {
    const s = server();
    expect(text((await s.handle('/src/data.json', '?import')).body)).toBe('export default {"n":1};');
    expect(text((await s.handle('/src/logo.svg', '?url')).body)).toBe(`export default "${BASE}src/logo.svg";`);
    expect(text((await s.handle('/src/notes.md', '?raw')).body)).toBe('export default "# notes";');
  });

  it('serves binary assets and public/ files at the root', async () => {
    const s = server();
    const png = await s.handle('/src/bg.png');
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.body).toBeInstanceOf(Uint8Array);
    expect(text((await s.handle('/robots.txt')).body)).toBe('User-agent: *');
  });

  it('falls back to the document for client-side routes and 404s missing files', async () => {
    const s = server();
    expect((await s.handle('/dashboard/settings')).status).toBe(200);
    expect((await s.handle('/missing.png')).status).toBe(404);
    expect(text((await s.handle('/src/Missing.tsx')).body)).toMatch(/^throw new Error/);
  });

  it('turns a compile error into a module that throws, naming the file', async () => {
    const fs = viteReactApp();
    fs.writeFile('/src/Broken.tsx', 'export const x = <div>;');
    const js = text((await server(fs).handle('/src/Broken.tsx')).body);
    expect(js).toMatch(/^throw new Error\(".*\/src\/Broken\.tsx/);
  });

  it('serves edits immediately and re-resolves when a new file appears', async () => {
    const fs = viteReactApp();
    const s = server(fs);
    expect(text((await s.handle('/src/components/Button.tsx')).body)).toContain('button');
    fs.writeFile('/src/components/Button.tsx', 'export function Button() { return <a>edited</a>; }');
    expect(text((await s.handle('/src/components/Button.tsx')).body)).toContain('edited');

    // A side-effect import: TS semantics would elide an unused default import.
    fs.writeFile('/src/main.tsx', `import './later';`);
    expect(text((await s.handle('/src/main.tsx')).body)).toMatch(/["']\.\/later["']/);
    fs.writeFile('/src/later.ts', 'export default 1;');
    expect(text((await s.handle('/src/main.tsx')).body)).toContain(`${BASE}src/later.ts`);
  });

  it('reports a Next.js project as unsupported instead of half-serving it', async () => {
    const fs = viteReactApp();
    fs.writeFile('/package.json', JSON.stringify({ dependencies: { next: '14.0.0' } }));
    const s = server(fs);
    expect(s.profile().supported).toBe(false);
    expect((await s.handle('/')).status).toBe(501);
  });
});

describe('DevServer on Create React App', () => {
  it('injects the entry and compiles JSX in .js files', async () => {
    const fs = new VirtualFileSystem();
    fs.mount({
      'package.json': JSON.stringify({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } }),
      'public/index.html': '<html><head><link rel="icon" href="%PUBLIC_URL%/favicon.ico"></head><body><div id="root"></div></body></html>',
      'src/index.js': `import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('root')).render(<h1>{process.env.REACT_APP_NAME}</h1>);`,
      '.env': 'REACT_APP_NAME=cra',
    });
    const s = server(fs);
    const html = text((await s.handle('/')).body);
    expect(html).toContain(`<script type="module" src="${BASE}src/index.js"></script>`);
    expect(html).toContain(`href="${BASE}favicon.ico"`);
    const js = text((await s.handle('/src/index.js')).body);
    expect(js).not.toContain('<h1>');
    expect(js).toContain('"cra"');
  });
});
