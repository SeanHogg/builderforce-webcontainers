/**
 * What the .NET runtime bundle holds, declared once: read by the runtime (the
 * project planner accepts exactly these NuGet packages) and by
 * scripts/build-dotnet-runtime.mjs, which loads this file directly (Node strips
 * the types) — so it imports nothing.
 *
 * The bundle is a URL artifact the host serves, never part of this npm package:
 * Mono's browser-wasm runtime and the host program (dotnet-host/), ASP.NET
 * Core's assemblies, Roslyn, the patched Npgsql, and the reference assemblies
 * builds compile against. Each release publishes it on its own as
 * {@link DOTNET_BUNDLE.npmPackage} at this package's exact version
 * (scripts/pack-dotnet-runtime.mjs, .github/workflows/release.yml): the immutable,
 * versioned source a host mirrors to serve the bundle beside its preview (npm never
 * accepts a version twice, so a version's bytes never change).
 */

/** A NuGet package the bundle carries: a project may reference it (any version; the bundled one is used). */
export interface BundledPackage {
  /** The package id as NuGet spells it. */
  readonly name: string;
  readonly version: string;
  /** Where its source is built from (patched for browser-wasm). */
  readonly repository: string;
  /** The release tag `commit` is (for people; the build fetches the commit, never the tag, which can be moved). */
  readonly tag: string;
  /** The exact commit built, checked after the fetch (`git rev-parse HEAD`). */
  readonly commit: string;
}

export const DOTNET_BUNDLE = {
  /** The manifest format the loader reads (2: every file's SHA-256, per packed reference too). */
  format: 2,
  /** What every build targets, whatever the project says (net8.0 and net9.0 projects compile against it). */
  targetFramework: 'net10.0',
  /** The host program's assembly (dotnet-host/BfwcDotnetHost.csproj), whose exports the Worker calls. */
  hostAssembly: 'Bfwc.DotnetHost',
  /** The npm package each release publishes the built bundle as, at the browser package's version. */
  npmPackage: '@seanhogg/builderforce-webcontainers-dotnet',
  /** Lower-cased package id → package. */
  packages: {
    npgsql: { name: 'Npgsql', version: '9.0.3', repository: 'https://github.com/npgsql/npgsql.git', tag: 'v9.0.3', commit: '97dc1739c6cf5890acf450f20f04e64c14c7ffd5' },
  } as Readonly<Record<string, BundledPackage>>,
} as const;
