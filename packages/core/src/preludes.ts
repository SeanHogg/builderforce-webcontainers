import type { ProjectProfile } from './detectProject.js';

/**
 * The entry module with the profile's preludes imported first (Angular:
 * `zone.js`, global styles, `@angular/compiler`). ES modules evaluate their
 * imports in source order, so these run before anything the entry imports.
 * They go on the first line, so the entry's own line numbers do not move.
 * Used by the dev server (compileModule) and the build (the build host) alike.
 */
export type PreludeProfile = Pick<ProjectProfile, 'entry' | 'preludes'>;

export function withPreludes(source: string, path: string, profile: PreludeProfile | undefined): string {
  if (!profile?.preludes?.length || path !== profile.entry) return source;
  return profile.preludes.map((specifier) => `import ${JSON.stringify(specifier)};`).join('') + source;
}
