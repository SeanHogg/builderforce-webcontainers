import type { ComponentCompiler } from '../components.js';
import type { TypeScriptOptions } from '../transformer.js';
import { ctorParameterEdits } from './ctorParameters.js';
import { scanSource } from './imports.js';
import { resourceEdits } from './resources.js';
import { signalMemberEdits } from './signalMembers.js';
import { applyEdits } from './syntax.js';
import { ANGULAR_MAJORS } from './versions.js';
import { isRegistryRange } from '../packageCdn.js';
import { rangeMajor } from '../pinGroups.js';

export { ANGULAR_MAJORS };

/**
 * Angular in JIT mode: every TypeScript module of an Angular project goes
 * through here (see `componentKindFor`), and is handed back still TypeScript,
 * with what the Angular CLI would have done to it in JIT mode:
 *   1. `templateUrl` / `styleUrl(s)` inlined (resources.ts),
 *   2. constructor parameters recorded for DI (ctorParameters.ts),
 *   3. signal inputs/outputs/queries given their decorators (signalMembers.ts),
 * and the TypeScript options the decorators need: legacy (experimental)
 * decorators, `[[Set]]` class fields, and — for zone.js apps — async/await
 * lowered so zone.js can track it. The browser's `@angular/compiler` then
 * compiles templates at runtime.
 *
 * The module is masked and its imports read ONCE (imports.ts `scanSource`); each
 * transform returns edits against that same text and they are applied together.
 * The edits never overlap: resources replace ranges inside `@Component(…)`,
 * the other two only insert (ctorParameters first in a class body, so a member
 * decorator inserted at the same offset still decorates its member).
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
      const scanned = scanSource(source);
      const edits = [...(await resourceEdits(scanned, request)), ...ctorParameterEdits(scanned), ...signalMemberEdits(scanned)];
      return { code: edits.length ? applyEdits(source, edits) : source, loader: 'ts', css: '', typescript };
    },
  };
}

/**
 * The Angular compiler for a project's dependencies: zone.js use read from them,
 * and an `@angular/core` range naming a major outside {@link ANGULAR_MAJORS}
 * refused with a clear message. A range that names no major — a dist-tag
 * (`latest`, `next`), `*`, or a non-registry range such as `workspace:*` — is
 * let through unchecked: the version it resolves to is not known here.
 */
export function angularCompilerFor(dependencies: Readonly<Record<string, string>>): ComponentCompiler {
  const range = dependencies['@angular/core'];
  const major = range && isRegistryRange(range) ? rangeMajor(range) : undefined;
  if (major !== undefined && (major < ANGULAR_MAJORS.min || major > ANGULAR_MAJORS.max)) {
    throw new Error(`Angular ${major} is not supported here: the instant preview runs Angular ${ANGULAR_MAJORS.min}–${ANGULAR_MAJORS.max} (standalone, JIT).`);
  }
  return createAngularCompiler({ zone: Object.hasOwn(dependencies, 'zone.js') });
}
