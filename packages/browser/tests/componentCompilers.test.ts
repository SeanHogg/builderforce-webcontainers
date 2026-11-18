import { describe, expect, it } from 'vitest';
import * as compilerSfc from '@vue/compiler-sfc';
import * as svelteCompiler from 'svelte/compiler';
import { createCdnComponentCompilers } from '../src/componentCompilers.js';

describe('createCdnComponentCompilers', () => {
  function loader() {
    const loaded: string[] = [];
    const importModule = async (url: string) => {
      loaded.push(url);
      if (url.includes('fail')) throw new Error('offline');
      return url.includes('compiler-sfc') ? compilerSfc : svelteCompiler;
    };
    return { loaded, importModule };
  }

  it('loads each compiler on first use, pinned to the project range, once', async () => {
    const { loaded, importModule } = loader();
    const compilers = createCdnComponentCompilers({ importModule });
    const vue = await compilers('.vue', { vue: '^3.5.0' });
    await compilers('.vue', { vue: '^3.5.0' });
    const out = await vue.compile('<template><p>hi</p></template>', { path: '/src/A.vue', dev: true });
    expect(out.code).toContain('export default _sfc_main');
    const svelte = await compilers('.svelte', { svelte: '^5.1.0' });
    expect((await svelte.compile('<p>hi</p>', { path: '/src/A.svelte', dev: false })).code).toContain('svelte/internal/client');
    expect(loaded).toEqual([
      'https://cdn.jsdelivr.net/npm/@vue/compiler-sfc@^3.5.0/dist/compiler-sfc.esm-browser.js',
      'https://esm.sh/svelte@^5.1.0/compiler',
    ]);
  });

  it('serves Angular 17–20 from the core without a download, and refuses other majors', async () => {
    const { loaded, importModule } = loader();
    const compilers = createCdnComponentCompilers({ importModule });
    const angular = await compilers('angular', { '@angular/core': '^20.0.0', 'zone.js': '~0.15.0' });
    const out = await angular.compile(`@Injectable() export class S { constructor(h: Http) {} }`, { path: '/src/s.ts', dev: true });
    expect(out.code).toContain('static ctorParameters = () => [{ type: Http }]');
    expect(out.typescript).toEqual({ experimentalDecorators: true, useDefineForClassFields: false, lowerAsync: true });
    expect((await (await compilers('angular', { '@angular/core': '~17.3.0' })).compile('', { path: '/a.ts', dev: true })).typescript?.lowerAsync).toBeUndefined();
    await expect(compilers('angular', { '@angular/core': '^16.2.0' })).rejects.toThrow(/Angular 16 is not supported/);
    await expect(compilers('angular', { '@angular/core': '^21.0.0' })).rejects.toThrow(/Angular 21 is not supported/);
    expect(loaded).toEqual([]);
  });

  it('falls back to the current major for non-registry ranges, and retries failed loads', async () => {
    const { loaded, importModule } = loader();
    const compilers = createCdnComponentCompilers({ importModule, svelteCompilerUrl: (range) => `https://fail.example/${range}` });
    await compilers('.vue', { vue: 'workspace:*' });
    expect(loaded[0]).toContain('@vue/compiler-sfc@3/');
    await expect(compilers('.svelte', {})).rejects.toThrow('offline');
    await expect(compilers('.svelte', {})).rejects.toThrow('offline');
    expect(loaded.filter((url) => url.includes('fail'))).toEqual(['https://fail.example/5', 'https://fail.example/5']);
  });
});
