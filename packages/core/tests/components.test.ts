import { describe, expect, it } from 'vitest';
import type { VirtualFileSystem } from '../src/vfs.js';
import { DevServer } from '../src/devServer.js';
import { noComponentCompilers } from '../src/components.js';
import { detectProject } from '../src/detectProject.js';
import { components, project, svelte, text, transformer, vue } from './helpers.js';

const BASE = '/__bfwc/c1/';

const SETUP_SFC = `<script setup lang="ts">
import { ref } from 'vue';
const count = ref<number>(0);
</script>
<template><button class="btn" @click="count++">{{ count }}</button></template>
<style scoped>.btn { color: red; }</style>`;

describe('Vue compiler', () => {
  it('compiles <script setup lang="ts"> with an inlined template and scoped CSS', async () => {
    const out = await vue.compile(SETUP_SFC, { path: '/src/App.vue', dev: true });
    expect(out.loader).toBe('ts');
    expect(out.code).toContain('export default _sfc_main');
    expect(out.code).toMatch(/__scopeId = "data-v-[0-9a-f]{8}"/);
    expect(out.css).toMatch(/\.btn\[data-v-[0-9a-f]{8}\]/);
    const scope = /data-v-([0-9a-f]{8})/.exec(out.code)![1];
    expect(out.css).toContain(`data-v-${scope}`);
  });

  it('compiles an options-API component with a separate render function', async () => {
    const sfc = `<script>export default { data: () => ({ n: 1 }) }</script><template><p>{{ n }}</p></template>`;
    const out = await vue.compile(sfc, { path: '/src/Opt.vue', dev: false });
    expect(out.loader).toBe('js');
    expect(out.code).toContain('_sfc_main.render = _sfc_render');
    expect(out.code).not.toContain('__scopeId');
    expect(out.css).toBe('');
  });

  it('compiles a template-only component', async () => {
    const out = await vue.compile('<template><p>hi</p></template>', { path: '/src/T.vue', dev: false });
    expect(out.code).toContain('const _sfc_main = {}');
    expect(out.code).toContain('_sfc_main.render');
  });

  it('declines style preprocessors with a clear reason', async () => {
    await expect(Promise.resolve().then(() => vue.compile('<template><p/></template><style lang="scss">a{}</style>', { path: '/src/S.vue', dev: true })))
      .rejects.toThrow(/preprocessor/);
  });

  it('gives each file a stable scope id', async () => {
    const a = await vue.compile(SETUP_SFC, { path: '/src/A.vue', dev: true });
    const again = await vue.compile(SETUP_SFC, { path: '/src/A.vue', dev: true });
    const b = await vue.compile(SETUP_SFC, { path: '/src/B.vue', dev: true });
    expect(a.css).toBe(again.css);
    expect(a.css).not.toBe(b.css);
  });
});

describe('Svelte compiler', () => {
  it('compiles a TS component to client JS with its CSS scoped and external', async () => {
    const src = `<script lang="ts">let count: number = $state(0);</script><button onclick={() => count++}>{count}</button><style>button { color: red; }</style>`;
    const out = await svelte.compile(src, { path: '/src/App.svelte', dev: false });
    expect(out.loader).toBe('js');
    expect(out.code).toMatch(/from ['"]svelte\/internal\/client['"]/);
    expect(out.css).toMatch(/button\.svelte-[a-z0-9]+/);
    expect(out.code).not.toContain('color: red');
  });
});

describe('DevServer with components', () => {
  function vueApp(): VirtualFileSystem {
    return project({
      'package.json': JSON.stringify({ dependencies: { vue: '^3.5.0' }, devDependencies: { vite: '^5.4.0', '@vitejs/plugin-vue': '^5.0.0' } }),
      'index.html': '<!doctype html><html><head></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>',
      'src/main.ts': `import { createApp } from 'vue';\nimport App from './App.vue';\ncreateApp(App).mount('#app');`,
      'src/App.vue': SETUP_SFC.replace('.btn { color: red; }', ".btn { color: red; background: url('./bg.png'); }"),
      'src/bg.png': 'png',
    });
  }

  function server(fs: VirtualFileSystem, withCompilers = true): DevServer {
    return new DevServer({ fs, transformer, base: BASE, components: withCompilers ? components : undefined });
  }

  it('maps .vue imports to served modules, not asset URLs', async () => {
    const js = text((await server(vueApp()).handle('/src/main.ts')).body);
    expect(js).toContain(`"${BASE}src/App.vue"`);
    expect(js).toMatch(/https:\/\/esm\.sh\/vue@\^3\.5\.0/);
  });

  it('serves a Vue SFC as a module with its scoped styles injected', async () => {
    const res = await server(vueApp()).handle('/src/App.vue');
    const js = text(res.body);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(js).not.toContain('<template>');
    expect(js).not.toContain('ref<number>'); // TS stripped
    expect(js).toMatch(/https:\/\/esm\.sh\/vue@\^3\.5\.0/);
    expect(js).toContain('data-bfwc');
    expect(js).toMatch(/\.btn\[data-v-[0-9a-f]{8}\]/);
    expect(js).toContain(`${BASE}src/bg.png`); // url() re-rooted for a <style> tag
  });

  it('serves a Svelte component with its runtime pinned to the project version', async () => {
    const fs = project({
      'package.json': JSON.stringify({ devDependencies: { svelte: '^5.0.0', vite: '^5.4.0' } }),
      'index.html': '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
      'src/App.svelte': '<h1>Hi</h1><style>h1 { color: blue; }</style>',
    });
    const js = text((await server(fs).handle('/src/App.svelte')).body);
    expect(js).toMatch(/https:\/\/esm\.sh\/svelte@\^5\.0\.0\/internal\/client/);
    expect(js).toMatch(/h1\.svelte-[a-z0-9]+/);
    expect(js).toContain('data-bfwc');
  });

  it('turns a component with no compiler configured into a throwing module', async () => {
    const res = await server(vueApp(), false).handle('/src/App.vue');
    expect(text(res.body)).toMatch(/throw new Error\(.*No compiler for \.vue/);
    await expect(noComponentCompilers('.svelte', {})).rejects.toThrow(/\.svelte/);
  });
});

describe('detectProject with Vue and Svelte', () => {
  it('accepts Vite + Vue and Vite + Svelte', () => {
    const v = detectProject(project({ 'index.html': '', 'package.json': '{"dependencies":{"vue":"^3"},"devDependencies":{"vite":"^5"}}' }));
    expect(v).toMatchObject({ supported: true, kind: 'vite', framework: 'vue' });
    const s = detectProject(project({ 'index.html': '', 'package.json': '{"devDependencies":{"svelte":"^5","vite":"^5"}}' }));
    expect(s).toMatchObject({ supported: true, kind: 'vite', framework: 'svelte' });
  });

  it('still declines the server frameworks built on them', () => {
    const kit = detectProject(project({ 'index.html': '', 'package.json': '{"devDependencies":{"@sveltejs/kit":"^2","svelte":"^5"}}' }));
    expect(kit).toMatchObject({ supported: false });
    expect(kit.reason).toMatch(/SvelteKit/);
    const nuxt = detectProject(project({ 'package.json': '{"dependencies":{"nuxt":"^3","vue":"^3"}}' }));
    expect(nuxt.reason).toMatch(/Nuxt/);
  });
});
