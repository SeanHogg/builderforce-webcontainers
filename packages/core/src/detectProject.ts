import type { VirtualFileSystem } from './vfs.js';
import { RESOLVE_EXTENSIONS } from './resolve.js';

export type ProjectKind = 'vite' | 'cra' | 'static';

/** The UI framework, when the project uses one this runtime compiles. */
export type ProjectFramework = 'react' | 'vue' | 'svelte';

export interface ProjectProfile {
  supported: boolean;
  kind?: ProjectKind;
  framework?: ProjectFramework;
  /** The HTML document served at `/`. */
  htmlPath?: string;
  /** Script injected when the HTML has no module entry of its own (CRA). */
  entry?: string;
  /** Files served from the site root, Vite/CRA `public/` convention. */
  publicDir: string;
  /** Why the project needs a full Node runtime instead — shown to the user. */
  reason?: string;
}

/**
 * Frameworks that need a server or a build pipeline this runtime does not have.
 * Data, not branches: supporting one later means deleting its row. Checked before
 * the plain-framework rules below, so SvelteKit and Nuxt (which depend on svelte
 * and vue) are declined rather than mistaken for a Vite + Svelte/Vue app.
 */
const NEEDS_NODE: ReadonlyArray<{ dependency: string; reason: string }> = [
  { dependency: 'next', reason: 'Next.js needs its Node server.' },
  { dependency: 'nuxt', reason: 'Nuxt needs its Node server.' },
  { dependency: '@remix-run/dev', reason: 'Remix needs its Node server.' },
  { dependency: '@sveltejs/kit', reason: 'SvelteKit needs its Node server.' },
  { dependency: 'astro', reason: 'Astro needs its build pipeline.' },
];

const SERVER_ONLY = ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi'];

function readDependencyNames(fs: VirtualFileSystem): Set<string> {
  try {
    const pkg = JSON.parse(fs.readText('/package.json') ?? '{}') as Record<string, Record<string, string> | undefined>;
    return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  } catch {
    return new Set();
  }
}

function detectFramework(deps: Set<string>): ProjectFramework | undefined {
  if (deps.has('vue')) return 'vue';
  if (deps.has('svelte')) return 'svelte';
  if (deps.has('react')) return 'react';
  return undefined;
}

function findEntry(fs: VirtualFileSystem): string | undefined {
  for (const stem of ['/src/index', '/src/main']) {
    for (const ext of RESOLVE_EXTENSIONS) if (fs.isFile(stem + ext)) return stem + ext;
  }
  return undefined;
}

export function detectProject(fs: VirtualFileSystem): ProjectProfile {
  const deps = readDependencyNames(fs);
  const blocker = NEEDS_NODE.find((row) => deps.has(row.dependency));
  if (blocker) return { supported: false, publicDir: '/public', reason: blocker.reason };

  const framework = detectFramework(deps);
  if (fs.isFile('/index.html')) {
    return { supported: true, kind: deps.has('vite') ? 'vite' : 'static', framework, htmlPath: '/index.html', publicDir: '/public' };
  }
  if (fs.isFile('/public/index.html')) {
    return { supported: true, kind: 'cra', framework, htmlPath: '/public/index.html', entry: findEntry(fs), publicDir: '/public' };
  }
  if (SERVER_ONLY.some((name) => deps.has(name))) {
    return { supported: false, publicDir: '/public', reason: 'This is a Node server app with no browser entry page.' };
  }
  return { supported: false, publicDir: '/public', reason: 'No index.html found at the project root or in public/.' };
}
