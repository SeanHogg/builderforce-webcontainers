import { describe, expect, it } from 'vitest';
import { DevServer } from '../src/devServer.js';
import { ModuleGraph } from '../src/hot/moduleGraph.js';
import { componentNames, refreshFacts } from '../src/hot/reactRefresh.js';
import type { PackageCdnFactory } from '../src/packageCdn.js';
import type { VirtualFileSystem } from '../src/vfs.js';
import { project, styles, text, transformer } from './helpers.js';

const BASE = '/__bfwc/p1/';
const cdn: PackageCdnFactory = () => ({ urlFor: (name, subpath) => `https://cdn.test/${name}${subpath}` });

function reactApp(): VirtualFileSystem {
  return project({
    'package.json': JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '^5.4.0' } }),
    'tsconfig.json': '{ "compilerOptions": { "jsx": "react-jsx" } }',
    'index.html': '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\ncreateRoot(document.getElementById('root')!).render(<App />);`,
    'src/App.tsx': `import { useState } from 'react';\nimport { Button } from './Button';\nimport { label } from './label';\nexport default function App() { const [n, setN] = useState(0); return <Button text={label(n)} onClick={() => setN(n + 1)} />; }`,
    'src/Button.tsx': `export function Button(p: { text: string; onClick(): void }) { return <button onClick={p.onClick}>{p.text}</button>; }`,
    'src/label.ts': `export const label = (n: number) => 'Clicked ' + n;`,
    'src/index.css': 'body { margin: 0; }',
    'src/_tokens.scss': '$gap: 1px;',
    'src/theme.scss': `@use 'tokens'; .t { gap: tokens.$gap; }`,
    'README.md': '# app',
  });
}

/** Serve what a browser opening the preview would request. */
async function open(server: DevServer): Promise<void> {
  await server.handle('/');
  await server.handle('/src/main.tsx');
  await server.handle('/src/App.tsx');
  await server.handle('/src/Button.tsx');
  await server.handle('/src/label.ts');
  await server.handle('/src/index.css', '?import');
}

function setup(fs = reactApp(), hot?: boolean) {
  return { fs, server: new DevServer({ fs, transformer, base: BASE, cdn, styles, hot }) };
}

/** Edit a file and plan the update a burst of just that edit produces. */
function edit(fs: VirtualFileSystem, server: DevServer, path: string, contents: string) {
  fs.writeFile(path, contents);
  return server.planUpdate([{ type: 'write', path }]);
}

describe('React Fast Refresh in the dev server', () => {
  it('installs the refresh runtime before the app and registers components', async () => {
    const { server } = setup();
    const page = text((await server.handle('/')).body);
    expect(page).toContain('import * as runtime from "https://cdn.test/react-refresh/runtime"');
    expect(page.indexOf('injectIntoGlobalHook')).toBeLessThan(page.indexOf('src/main.tsx'));
    const app = text((await server.handle('/src/App.tsx')).body);
    expect(app).toContain('refresh.register(App, "/src/App.tsx App")');
  });

  it('re-runs an edited component module in place', async () => {
    const { fs, server } = setup();
    await open(server);
    const update = edit(fs, server, '/src/Button.tsx', `export function Button(p: { text: string; onClick(): void }) { return <button className="b" onClick={p.onClick}>{p.text}</button>; }`);
    expect(update).toEqual({ type: 'update', styles: [], modules: [`${BASE}src/Button.tsx?t=1`] });
  });

  it('carries a non-component edit up to the component importing it, with fresh imports below', async () => {
    const { fs, server } = setup();
    await open(server);
    const update = edit(fs, server, '/src/label.ts', `export const label = (n: number) => 'Count: ' + n;`);
    expect(update).toEqual({ type: 'update', styles: [], modules: [`${BASE}src/App.tsx?t=1`] });
    const app = text((await server.handle('/src/App.tsx')).body);
    expect(app).toContain(`${BASE}src/label.ts?t=1`);
  });

  it('reloads when the hooks a component calls change', async () => {
    const { fs, server } = setup();
    await open(server);
    const update = edit(fs, server, '/src/App.tsx', `import { useState, useEffect } from 'react';\nimport { Button } from './Button';\nimport { label } from './label';\nexport default function App() { const [n, setN] = useState(0); useEffect(() => {}); return <Button text={label(n)} onClick={() => setN(n + 1)} />; }`);
    expect(update).toEqual({ type: 'reload' });
  });

  it('reloads for an edit to the entry, which nothing imports', async () => {
    const { fs, server } = setup();
    await open(server);
    expect(edit(fs, server, '/src/main.tsx', `import { createRoot } from 'react-dom/client';\nimport App from './App';\ncreateRoot(document.body).render(<App />);`)).toEqual({ type: 'reload' });
  });

  it('swaps a stylesheet without re-running any module', async () => {
    const { fs, server } = setup();
    await open(server);
    const update = edit(fs, server, '/src/index.css', 'body { margin: 4px; }');
    expect(update).toEqual({ type: 'update', styles: [{ path: `${BASE}src/index.css`, url: `${BASE}src/index.css?import&t=1`, stamp: 1 }], modules: [] });
  });

  it('swaps the stylesheet a Sass partial feeds', async () => {
    const { fs, server } = setup();
    await open(server);
    await server.handle('/src/theme.scss', '?import');
    const update = edit(fs, server, '/src/_tokens.scss', '$gap: 9px;');
    expect(update).toMatchObject({ type: 'update', modules: [], styles: [{ path: `${BASE}src/theme.scss` }] });
    expect(text((await server.handle('/src/theme.scss', '?import')).body)).toContain('gap: 9px');
  });

  it('ignores files the preview never loaded, and reloads when files are added', async () => {
    const { fs, server } = setup();
    await open(server);
    expect(edit(fs, server, '/README.md', '# changed')).toBeUndefined();
    fs.writeFile('/src/New.tsx', 'export const x = 1;');
    expect(server.planUpdate([{ type: 'write', path: '/src/New.tsx', created: true }])).toEqual({ type: 'reload' });
  });

  it('reloads on every edit when hot updates are off', async () => {
    const { fs, server } = setup(reactApp(), false);
    await open(server);
    expect(edit(fs, server, '/src/index.css', 'body { margin: 1px; }')).toEqual({ type: 'reload' });
    expect(text((await server.handle('/')).body)).not.toContain('react-refresh');
  });

  it('reloads a non-React app for script edits but still swaps its styles', async () => {
    const fs = project({
      'package.json': JSON.stringify({ devDependencies: { vite: '^5.4.0' } }),
      'index.html': '<html><head><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/main.js"></script></body></html>',
      'main.js': `import { greet } from './greet.js'; greet();`,
      'greet.js': `export function greet() {}`,
      'style.css': 'p {}',
    });
    const { server } = setup(fs);
    await server.handle('/');
    await server.handle('/main.js');
    await server.handle('/greet.js');
    await server.handle('/style.css');
    expect(edit(fs, server, '/greet.js', 'export function greet() { return 1; }')).toEqual({ type: 'reload' });
    expect(edit(fs, server, '/style.css', 'p { color: red }')).toMatchObject({ type: 'update', styles: [{ path: `${BASE}style.css` }] });
  });
});

describe('refresh analysis', () => {
  it('finds component bindings in compiled code', () => {
    const code = [
      'export default function App() {}',
      'export const Card = (p) => null;',
      'const List = memo(function List() {});',
      'export const Input = React.forwardRef((p, r) => null);',
      'class Modal extends Component {}',
      'export const useThing = () => 1;',
      'const MAX = 3;',
    ].join('\n');
    expect(componentNames(code).sort()).toEqual(['App', 'Card', 'Input', 'List', 'Modal']);
  });

  it('treats a module as a boundary only when every export is a component', async () => {
    expect((await refreshFacts('export function A() {}\nexport const B = () => null;', '', ['A', 'B'])).refreshBoundary).toBe(true);
    expect((await refreshFacts('export function A() {}\nexport const x = 1;', '', ['A'])).refreshBoundary).toBe(false);
    expect((await refreshFacts('const A = () => null;\nexport default A;', '', ['A'])).refreshBoundary).toBe(true);
    expect((await refreshFacts('const x = 1;', '', [])).refreshBoundary).toBe(false);
  });
});

describe('ModuleGraph', () => {
  it('tracks importers, dependents and stamps', () => {
    const graph = new ModuleGraph();
    graph.setDependencies('/a', ['/b']);
    graph.setDependencies('/b', ['/c']);
    expect([...graph.dependents('/c')].sort()).toEqual(['/a', '/b']);
    graph.setDependencies('/b', []);
    expect(graph.importers('/c').size).toBe(0);
    const stamp = graph.bump(['/a', '/b']);
    expect(graph.stampOf('/a')).toBe(stamp);
    expect(graph.bump(['/a'])).toBe(stamp + 1);
  });
});
