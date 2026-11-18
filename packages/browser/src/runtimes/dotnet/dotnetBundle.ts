/**
 * What the .NET runtime bundle holds, declared once: read by the runtime (the
 * project planner accepts exactly these NuGet packages) and by
 * scripts/build-dotnet-runtime.mjs, which loads this file directly (Node strips
 * the types) — so it imports nothing.
 *
 * The bundle is a URL artifact the host serves, never part of the npm package:
 * Mono's browser-wasm runtime and the host program (dotnet-host/), ASP.NET
 * Core's assemblies, Roslyn, the patched Npgsql, and the reference assemblies
 * builds compile against.
 */

/** A NuGet package the bundle carries: a project may reference it (any version; the bundled one is used). */
export interface BundledPackage {
  /** The package id as NuGet spells it. */
  readonly name: string;
  readonly version: string;
  /** Where its source is built from (patched for browser-wasm). */
  readonly repository: string;
  readonly tag: string;
}

export const DOTNET_BUNDLE = {
  /** The manifest format the loader reads. */
  format: 1,
  /** What every build targets, whatever the project says (net8.0 and net9.0 projects compile against it). */
  targetFramework: 'net10.0',
  /** The host program's assembly (dotnet-host/BfwcDotnetHost.csproj), whose exports the Worker calls. */
  hostAssembly: 'Bfwc.DotnetHost',
  /** Lower-cased package id → package. */
  packages: {
    npgsql: { name: 'Npgsql', version: '9.0.3', repository: 'https://github.com/npgsql/npgsql.git', tag: 'v9.0.3' },
  } as Readonly<Record<string, BundledPackage>>,
} as const;
