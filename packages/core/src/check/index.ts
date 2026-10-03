/**
 * `@seanhogg/builderforce-webcontainers-core/check` — type-checking a project in
 * memory. A separate entry point because it is typed against the `typescript`
 * package (an optional peer dependency), which the rest of the core never needs.
 */
export { typecheckProject } from './typecheck.js';
export type { TypecheckOptions, TypecheckResult } from './typecheck.js';
export { toCheckDiagnostic, formatDiagnostic, sortDiagnostics } from './diagnostics.js';
export type { CheckDiagnostic, DiagnosticCategory } from './diagnostics.js';
export { acquireTypes, acquireExtendedConfigs } from './acquire.js';
export type { FetchLike, FetchResponseLike, AcquireRequest, AcquireOptions } from './acquire.js';
export { resolveCheckProjects, defaultCompilerOptions, createParseConfigHost } from './projects.js';
export type { CheckProject } from './projects.js';
export { createVirtualHost } from './compilerHost.js';
export type { VirtualHostOptions } from './compilerHost.js';
export { ambientShim, declaresModule, AMBIENT_SHIM_PATH, SHIMMED_TYPE_REFERENCES } from './shims.js';
export {
  TypeStore,
  libBaseUrlFor,
  typesPackageName,
  dtsCandidates,
  packageRequestUrl,
  DEFAULT_TYPES_ORIGIN,
  DEFAULT_NPM_BASE_URL,
  TYPES_DIR,
  LIB_DIR,
} from './typeStore.js';
export type { TypeSources } from './typeStore.js';
