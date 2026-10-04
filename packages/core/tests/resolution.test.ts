import { describe, expect, it } from 'vitest';
import { VirtualFileSystem } from '../src/vfs.js';
import { isBareSpecifier, resolveAlias, resolveLocal, splitPackageSpecifier } from '../src/resolve.js';
import { parseDotenv, parseLooseJson, readProjectConfig } from '../src/projectConfig.js';
import { createEsmShCdn, loadPackageManifests } from '../src/packageCdn.js';
import { rewriteImports } from '../src/rewriteImports.js';

describe('resolveLocal', () => {
  const fs = new VirtualFileSystem();
  fs.mount({
    'src/App.tsx': '',
    'src/util.ts': '',
    'src/components/index.tsx': '',
    'src/styles.css': '',
  });

  it('probes extensions, index files and the .js→.ts convention', () => {
    expect(resolveLocal(fs, '/src', './App')).toBe('/src/App.tsx');
    expect(resolveLocal(fs, '/src', './components')).toBe('/src/components/index.tsx');
    expect(resolveLocal(fs, '/src', './util.js')).toBe('/src/util.ts');
    expect(resolveLocal(fs, '/src/components', '../styles.css')).toBe('/src/styles.css');
    expect(resolveLocal(fs, '/', '/src/App.tsx')).toBe('/src/App.tsx');
    expect(resolveLocal(fs, '/src', './missing')).toBeUndefined();
  });
});

describe('bare specifiers', () => {
  it('tells bare from relative, absolute and URL specifiers', () => {
    expect(isBareSpecifier('react')).toBe(true);
    expect(isBareSpecifier('@/components/x')).toBe(true);
    expect(isBareSpecifier('./a')).toBe(false);
    expect(isBareSpecifier('/a')).toBe(false);
    expect(isBareSpecifier('https://x.dev/a.js')).toBe(false);
    expect(isBareSpecifier('node:fs')).toBe(false);
  });
  it('splits scoped and unscoped names from subpaths', () => {
    expect(splitPackageSpecifier('react-dom/client')).toEqual({ name: 'react-dom', subpath: '/client' });
    expect(splitPackageSpecifier('@tanstack/react-query')).toEqual({ name: '@tanstack/react-query', subpath: '' });
    expect(splitPackageSpecifier('@scope/pkg/a/b')).toEqual({ name: '@scope/pkg', subpath: '/a/b' });
  });
});

describe('project config', () => {
  it('parses tsconfig with comments and trailing commas', () => {
    expect(parseLooseJson('{ // c\n "a": "x//y", /* b */ "b": [1,2,], }')).toEqual({ a: 'x//y', b: [1, 2] });
  });

  it('reads aliases, JSX mode, dependencies and .env', () => {
    const fs = new VirtualFileSystem();
    fs.mount({
      'package.json': JSON.stringify({ dependencies: { react: '^18.3.1' }, devDependencies: { vite: '^5.0.0' } }),
      'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], "~ui": ["./src/ui/index.ts"] }, "jsx": "react-jsx", }, }',
      '.env': 'VITE_API=https://api.dev\n# note\nSECRET="x"',
      '.env.local': 'VITE_API=https://local.dev',
      'src/components/Button.tsx': '',
      'src/ui/index.ts': '',
    });
    const config = readProjectConfig(fs);
    expect(config.dependencies).toEqual({ vite: '^5.0.0', react: '^18.3.1' });
    expect(config.jsx).toEqual({ runtime: 'automatic', importSource: 'react' });
    expect(config.env).toEqual({ VITE_API: 'https://local.dev', SECRET: 'x' });
    expect(resolveAlias(fs, config.aliases, '@/components/Button')).toBe('/src/components/Button.tsx');
    expect(resolveAlias(fs, config.aliases, '~ui')).toBe('/src/ui/index.ts');
    expect(resolveAlias(fs, config.aliases, 'react')).toBeUndefined();
  });

  it('parses dotenv quoting and export prefixes', () => {
    expect(parseDotenv("export A='1'\nB = two\n\n#C=3")).toEqual({ A: '1', B: 'two' });
  });
});

describe('createEsmShCdn', () => {
  it('versions the package and, with no manifest, pins every other dependency', () => {
    const cdn = createEsmShCdn({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', local: 'workspace:*' } });
    const url = cdn.urlFor('react-dom', '/client');
    expect(url.startsWith('https://esm.sh/react-dom@^18.3.1/client?deps=')).toBe(true);
    expect(url).toContain(encodeURIComponent('react@^18.3.1'));
    expect(url).not.toContain('local');
    expect(url.endsWith('&dev')).toBe(true);
  });
  it('pins only what a package imports, so the app and react-dom share ONE react', () => {
    const cdn = createEsmShCdn({
      dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0', vite: '^4.3.9' },
      manifests: { react: {}, 'react-dom': { peerDependencies: { react: '^18.3.1' } }, vite: {} },
    });
    // esm.sh links react-dom's own `import 'react'` to the plain react build; the app must too.
    expect(cdn.urlFor('react', '')).toBe('https://esm.sh/react@^18.2.0?dev');
    expect(cdn.urlFor('react', '/jsx-runtime')).toBe('https://esm.sh/react@^18.2.0/jsx-runtime?dev');
    expect(cdn.urlFor('react-dom', '/client')).toBe(`https://esm.sh/react-dom@^18.2.0/client?deps=${encodeURIComponent('react@^18.2.0')}&dev`);
    // An undeclared package carries every pin, so the packages IT imports dedupe.
    expect(cdn.urlFor('framer-motion', '')).toContain(encodeURIComponent('react@^18.2.0'));
  });
  it('loads manifests from the CDN and leaves out the ones that fail', async () => {
    const seen: string[] = [];
    const manifests = await loadPackageManifests(
      { 'react-dom': '^18.2.0', broken: '^1.0.0', local: 'workspace:*' },
      {
        origin: 'https://cdn.test',
        fetch: async (url) => {
          seen.push(url);
          if (url.includes('broken')) return { ok: false, json: async () => ({}) };
          return { ok: true, json: async () => ({ peerDependencies: { react: '^18.3.1' } }) };
        },
      },
    );
    expect(manifests).toEqual({ 'react-dom': { peerDependencies: { react: '^18.3.1' } } });
    expect(seen).toEqual(['https://cdn.test/react-dom@^18.2.0/package.json', 'https://cdn.test/broken@^1.0.0/package.json']);
  });
  it('falls back to an unversioned URL for undeclared packages', () => {
    expect(createEsmShCdn({ dev: false }).urlFor('lodash-es', '')).toBe('https://esm.sh/lodash-es');
  });
});

describe('rewriteImports', () => {
  const map = (s: string) => (s.startsWith('x') ? `/mapped/${s}` : undefined);

  it('rewrites static, re-export, side-effect and literal dynamic imports', async () => {
    const code = [
      `import a from 'xa';`,
      `export { b } from "xb";`,
      `import 'xc';`,
      `const d = await import('xd');`,
      `import keep from 'keep';`,
    ].join('\n');
    const out = await rewriteImports(code, map);
    expect(out).toContain(`from '/mapped/xa'`);
    expect(out).toContain(`from "/mapped/xb"`);
    expect(out).toContain(`import '/mapped/xc'`);
    expect(out).toContain(`import("/mapped/xd")`);
    expect(out).toContain(`from 'keep'`);
  });

  it('leaves strings, non-literal dynamic imports and import.meta alone', async () => {
    const code = `const s = "import x from 'xa'"; const m = import(name); console.log(import.meta.url);`;
    expect(await rewriteImports(code, map)).toBe(code);
  });
});
