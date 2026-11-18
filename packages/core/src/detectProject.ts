import type { VirtualFileSystem } from './vfs.js';
import { RESOLVE_EXTENSIONS } from './resolve.js';
import { PUBLIC_DIR, type StaticDir } from './staticDirs.js';
import { angularProfile, isAngularProject } from './angular/profile.js';
import { findHtmlEntries } from './buildHtml.js';
import { readDependencies } from './projectConfig.js';

export type ProjectKind = 'vite' | 'cra' | 'static' | 'angular';

/** The UI framework, when the project uses one this runtime compiles. */
export type ProjectFramework = 'react' | 'vue' | 'svelte' | 'angular';

export interface ProjectProfile {
  supported: boolean;
  kind?: ProjectKind;
  framework?: ProjectFramework;
  /** The HTML document served at `/`. */
  htmlPath?: string;
  /** Script injected when the HTML has no module entry of its own (CRA, Angular). */
  entry?: string;
  /**
   * Specifiers the entry module imports, in order, before its own imports
   * (Angular: polyfills, global styles, the JIT compiler). Absolute paths are
   * VFS files; anything else is a package.
   */
  preludes?: readonly string[];
  /** Files served as-is: Vite/CRA `public/` at the site root, Angular `assets`. */
  staticDirs: readonly StaticDir[];
  /** Why the project needs a full Node runtime instead — shown to the user. */
  reason?: string;
}

/**
 * Frameworks that run their own dev server, which the instant preview does not
 * replace: they run as Node processes here (`npm run dev`, Next.js on its wasm
 * SWC, SvelteKit/Nuxt on real Vite). Checked before the plain-framework rules
 * below, so SvelteKit and Nuxt (which depend on svelte and vue) are not mistaken
 * for a Vite + Svelte/Vue app.
 */
const NEEDS_NODE: ReadonlyArray<{ dependency: string; reason: string }> = [
  { dependency: 'next', reason: 'Next.js needs its Node server.' },
  { dependency: 'nuxt', reason: 'Nuxt needs its Node server.' },
  { dependency: '@remix-run/dev', reason: 'Remix needs its Node server.' },
  { dependency: '@sveltejs/kit', reason: 'SvelteKit needs its Node server.' },
  { dependency: 'astro', reason: 'Astro needs its build pipeline.' },
  { dependency: '@analogjs/platform', reason: 'Analog needs its Vite build pipeline.' },
];

const SERVER_ONLY = ['express', 'fastify', 'koa', '@nestjs/core', '@hapi/hapi'];

function readDependencyNames(fs: VirtualFileSystem): Set<string> {
  return new Set(Object.keys(readDependencies(fs)));
}

function detectFramework(deps: Set<string>): ProjectFramework | undefined {
  if (deps.has('@angular/core')) return 'angular';
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

/** Why the project's framework runs its own dev server (Next.js, Nuxt, SvelteKit…), or undefined. */
export function ownServerReason(fs: VirtualFileSystem): string | undefined {
  const deps = readDependencyNames(fs);
  return NEEDS_NODE.find((row) => deps.has(row.dependency))?.reason;
}

export function detectProject(fs: VirtualFileSystem): ProjectProfile {
  const blocker = ownServerReason(fs);
  if (blocker) return { supported: false, staticDirs: PUBLIC_DIR, reason: blocker };
  const deps = readDependencyNames(fs);

  const framework = detectFramework(deps);
  const angular = framework === 'angular' ? angularProfile(fs, deps) : undefined;
  // An Angular app without the CLI's page (a Vite-based setup) falls through to the rules below.
  if (angular && isAngularProject(fs, deps) && fs.isFile(angular.htmlPath)) return { supported: true, kind: 'angular', framework, ...angular };
  /**
   * Every `.ts` of an Angular project goes through the Angular compiler, whose
   * output needs `@angular/compiler` (and zone.js, polyfills, global styles)
   * loaded first — so whatever the page, an Angular app's entry carries the preludes.
   */
  const preludesFor = (htmlPath: string, entry: string | undefined) => {
    if (!angular) return entry ? { entry } : {};
    const own = findHtmlEntries(fs, fs.readText(htmlPath) ?? '', htmlPath).find((found) => found.tag === 'script')?.path;
    const resolved = own ?? entry;
    return resolved ? { entry: resolved, preludes: angular.preludes } : {};
  };
  if (fs.isFile('/index.html')) {
    return { supported: true, kind: deps.has('vite') ? 'vite' : 'static', framework, htmlPath: '/index.html', ...preludesFor('/index.html', undefined), staticDirs: PUBLIC_DIR };
  }
  if (fs.isFile('/public/index.html')) {
    return { supported: true, kind: 'cra', framework, htmlPath: '/public/index.html', ...preludesFor('/public/index.html', findEntry(fs)), staticDirs: PUBLIC_DIR };
  }
  if (SERVER_ONLY.some((name) => deps.has(name))) {
    return { supported: false, staticDirs: PUBLIC_DIR, reason: 'This is a Node server app with no browser entry page.' };
  }
  return { supported: false, staticDirs: PUBLIC_DIR, reason: 'No index.html found at the project root or in public/.' };
}
