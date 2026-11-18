/**
 * The .NET runtime (PRD 31 §W9 phase 6c): Mono's browser-wasm runtime in a
 * process Worker, Roslyn building projects in the browser, ASP.NET Core
 * served through an in-memory server on virtual ports, and Npgsql over the
 * runtime's virtual TCP. The runtime itself is a host-served bundle
 * (scripts/build-dotnet-runtime.mjs). For the package's `./app` to re-export.
 */
export { DOTNET_BUNDLE } from './dotnetBundle.js';
export type { BundledPackage } from './dotnetBundle.js';
export { DOTNET_COMMAND_PATTERN, isDotnetCommand, parseDotnetCommand } from './dotnetCommand.js';
export type { DotnetCommandParse, DotnetInfo, DotnetInvocation } from './dotnetCommand.js';
export { evaluateCondition, expandProperties, globMatcher, parseFileBasedProgram, parseProjectFile } from './dotnetProjectFile.js';
export type { PackageRef, ProjectFile, UsingItem } from './dotnetProjectFile.js';
export { findProject, frameworkDefines, planBuild } from './dotnetBuildPlan.js';
export type { DotnetBuildPlan, PlanResult, ProjectFiles } from './dotnetBuildPlan.js';
export { readLaunchProfile, splitArgs } from './dotnetLaunch.js';
export type { LaunchProfile, LaunchResult } from './dotnetLaunch.js';
export { BUNDLE_CACHE_PREFIX, DotnetBundleError, REFERENCE_ROOT, loadDotnetRuntime, readManifest, sha256Hex } from './dotnetLoader.js';
export type { DotnetBundleManifest, DotnetExports, DotnetImports, DotnetLoadOptions, LoadedDotnet, PackedFile } from './dotnetLoader.js';
export { createDotnetBridge } from './dotnetInterop.js';
export type { Dial as DotnetDial, DotnetBridge, DotnetBridgeOptions } from './dotnetInterop.js';
export { DOTNET_ENV, compilePlan, prepareInvocation, runWithRuntime } from './dotnetProgram.js';
export type { DotnetIo, PrepareContext, Prepared, RuntimeWork } from './dotnetProgram.js';
export type { DotnetStartOptions } from './dotnetStartOptions.js';
export { DOTNET_KIND, createDotnetProcessKind } from './dotnetProcessKind.js';
export type { DotnetHostOptions } from './dotnetProcessKind.js';
export { createDotnetWorkerProcess } from './dotnetWorkerProcess.js';
export type { DotnetWorkerProcessDeps } from './dotnetWorkerProcess.js';
export { acceptsDotnetService, createDotnetProvider } from './dotnetProvider.js';
export type { DotnetProviderOptions } from './dotnetProvider.js';
