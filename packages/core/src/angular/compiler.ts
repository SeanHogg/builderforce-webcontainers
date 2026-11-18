import type { ComponentCompiler } from '../components.js';
import type { TypeScriptOptions } from '../transformer.js';
import { addCtorParameters } from './ctorParameters.js';
import { inlineResources } from './resources.js';
import { addSignalMemberDecorators } from './signalMembers.js';
import { isRegistryRange } from '../packageCdn.js';
import { rangeMajor } from '../pinGroups.js';

/**
 * Angular in JIT mode: every TypeScript module of an Angular project goes
 * through here (see `componentKindFor`), and is handed back still TypeScript,
 * with what the Angular CLI would have done to it in JIT mode:
 *   1. `templateUrl` / `styleUrl(s)` inlined (resources.ts),
 *   2. signal inputs/outputs/queries given their decorators (signalMembers.ts),
 *   3. constructor parameters recorded for DI (ctorParameters.ts),
 * and the TypeScript options the decorators need: legacy (experimental)
 * decorators, `[[Set]]` class fields, and — for zone.js apps — async/await
 * lowered so zone.js can track it. The browser's `@angular/compiler` then
 * compiles templates at runtime.
 */
export interface AngularCompilerOptions {
  /** The app runs on zone.js (it is a dependency): lower async/await. */
  zone: boolean;
}

export function createAngularCompiler(options: AngularCompilerOptions): ComponentCompiler {
  const typescript: TypeScriptOptions = {
    experimentalDecorators: true,
    useDefineForClassFields: false,
    ...(options.zone ? { lowerAsync: true } : {}),
  };
  return {
    async compile(source, request) {
      const inlined = await inlineResources(source, request);
      const code = addCtorParameters(addSignalMemberDecorators(inlined), request.path);
      return { code, loader: 'ts', css: '', typescript };
    },
  };
}

/** The supported Angular majors. */
export const ANGULAR_MAJORS = { min: 17, max: 20 } as const;

/**
 * The Angular compiler for a project's dependencies: zone.js use read from them,
 * and an `@angular/core` range outside {@link ANGULAR_MAJORS} refused with a
 * clear message (a non-registry range such as `workspace:*` is let through).
 */
export function angularCompilerFor(dependencies: Readonly<Record<string, string>>): ComponentCompiler {
  const range = dependencies['@angular/core'];
  const major = range && isRegistryRange(range) ? rangeMajor(range) : undefined;
  if (major !== undefined && (major < ANGULAR_MAJORS.min || major > ANGULAR_MAJORS.max)) {
    throw new Error(`Angular ${major} is not supported here: the instant preview runs Angular ${ANGULAR_MAJORS.min}–${ANGULAR_MAJORS.max} (standalone, JIT).`);
  }
  return createAngularCompiler({ zone: Object.hasOwn(dependencies, 'zone.js') });
}
