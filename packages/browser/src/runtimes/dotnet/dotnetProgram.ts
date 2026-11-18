/**
 * What a `dotnet` invocation does, in two steps. `prepareInvocation` works on
 * the project files alone — the informational switches, `restore`, `clean`,
 * and for `build`/`run`/`exec` the build plan, the launch profile and the
 * program's environment — so a project the runtime cannot build fails before
 * the runtime is fetched. `runWithRuntime` then builds with Roslyn and runs
 * the program inside the started runtime, returning its exit code (a served
 * app's when it stops).
 */
import { dirname, resolveFrom, type VfsOp, type VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { toMountPath } from '../emscripten/projectMirror.js';
import { cleanTargets, findProject, planBuild, type DotnetBuildPlan } from './dotnetBuildPlan.js';
import type { DotnetInfo, DotnetInvocation } from './dotnetCommand.js';
import { readLaunchProfile, type LaunchResult } from './dotnetLaunch.js';
import type { DotnetBundleManifest, LoadedDotnet } from './dotnetLoader.js';

export interface DotnetIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface PrepareContext {
  files: VirtualFileSystem;
  cwd: string;
  env: Record<string, string>;
  io: DotnetIo;
  /** Send file changes to the page (`clean`). */
  sendOps(ops: VfsOp[]): void;
  /** The bundle's manifest, for the informational switches. */
  manifest(): Promise<DotnetBundleManifest>;
}

/** What the runtime must do: build (a plan), run (an assembly, as a runtime path), or both. */
export interface RuntimeWork {
  env: Record<string, string>;
  build?: DotnetBuildPlan;
  run?: { assembly: string; args: string[]; cwd: string };
}

export type Prepared = { kind: 'done'; code: number } | { kind: 'runtime'; work: RuntimeWork };

/** Environment every .NET process gets (the CLI's quiet defaults). */
export const DOTNET_ENV: Readonly<Record<string, string>> = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

/** Where an assembly is inside the runtime: a project path under the mount, a scratch path as is. */
export const runtimePathOf = (plan: Pick<DotnetBuildPlan, 'outputPath' | 'outputInProject'>) => (plan.outputInProject ? toMountPath(plan.outputPath) : plan.outputPath);

function infoText(what: DotnetInfo, manifest: DotnetBundleManifest): string {
  const runtimes = `Microsoft.AspNetCore.App ${manifest.runtimeVersion} [browser]\nMicrosoft.NETCore.App ${manifest.runtimeVersion} [browser]\n`;
  switch (what) {
    case 'version':
      return `${manifest.sdkVersion}\n`;
    case 'list-sdks':
      return `${manifest.sdkVersion} [browser]\n`;
    case 'list-runtimes':
      return runtimes;
    case 'info':
      return `.NET SDK:\n Version:           ${manifest.sdkVersion}\n\nRuntime Environment:\n OS Name:     browser\n RID:         browser-wasm\n\n.NET runtimes installed:\n${runtimes.replace(/^/gm, '  ').trimEnd()}\n`;
    default:
      return 'Usage: dotnet [command] [options]\n\nCommands available in the browser runtime:\n  run        Build and run a project, or a file-based program (dotnet run app.cs).\n  build      Build a project.\n  clean      Remove a project\'s build output.\n  restore    Check a project\'s packages against the bundled ones.\n  <app.dll>  Run a built application.\n';
  }
}

function plan(context: PrepareContext, invocation: Extract<DotnetInvocation, { kind: 'build' | 'run' | 'clean' | 'restore' }>): { ok: true; plan: DotnetBuildPlan } | { ok: false; reason: string } {
  const configuration = 'configuration' in invocation ? invocation.configuration : 'Debug';
  if (invocation.kind === 'run' && invocation.file) return planBuild(context.files, resolveFrom(context.cwd, invocation.file), configuration);
  const found = findProject(context.files, context.cwd, invocation.project, invocation.kind === 'run' ? 'run' : 'build');
  if (!found.ok) return found;
  return planBuild(context.files, found.path, configuration, invocation.kind === 'build' ? invocation.output : undefined);
}

export async function prepareInvocation(invocation: DotnetInvocation, context: PrepareContext): Promise<Prepared> {
  const { io } = context;
  const fail = (reason: string): Prepared => {
    io.stderr(`${reason}\n`);
    return { kind: 'done', code: 1 };
  };
  const env = { ...DOTNET_ENV, ...context.env };
  switch (invocation.kind) {
    case 'info':
      io.stdout(infoText(invocation.what, await context.manifest()));
      return { kind: 'done', code: 0 };
    case 'exec':
      return { kind: 'runtime', work: { env, run: { assembly: toMountPath(resolveFrom(context.cwd, invocation.assembly)), args: invocation.appArgs, cwd: toMountPath(context.cwd) } } };
    case 'restore':
    case 'clean': {
      const planned = plan(context, invocation);
      if (!planned.ok) return fail(planned.reason);
      if (invocation.kind === 'clean') {
        const targets = cleanTargets(planned.plan);
        if (!targets.ok) return fail(targets.reason);
        const present = targets.paths.filter((path) => context.files.isFile(path));
        if (present.length) context.sendOps(present.map((path) => ({ op: 'remove', path })));
        io.stdout(present.length ? present.map((path) => `  Deleting file "${path}".\n`).join('') : `  Nothing to clean in ${dirname(planned.plan.outputPath)}.\n`);
      } else {
        for (const note of planned.plan.notes) io.stdout(`  ${note}\n`);
        io.stdout(`  Restore complete: ${planned.plan.projectFile} uses ${planned.plan.packages.length ? 'bundled packages only' : 'no NuGet packages'}.\n`);
      }
      return { kind: 'done', code: 0 };
    }
    case 'build': {
      const planned = plan(context, invocation);
      if (!planned.ok) return fail(planned.reason);
      return { kind: 'runtime', work: { env, build: planned.plan } };
    }
    case 'run': {
      const planned = plan(context, invocation);
      if (!planned.ok) return fail(planned.reason);
      const built = planned.plan;
      if (built.outputKind !== 'exe') return fail(`Unable to run your project.\nEnsure you have a runnable project type and ensure '${built.projectFile}' supports running: its OutputType is Library.`);
      const launch: LaunchResult = built.fileBased ? { ok: true } : readLaunchProfile((path) => context.files.readText(path), built.projectDir, invocation.launchProfile, env);
      if (!launch.ok) return fail(launch.reason);
      // The Web SDK runs the program in its project directory (RunWorkingDirectory), so appsettings.json is found.
      const cwd = built.web ? built.projectDir : context.cwd;
      return {
        kind: 'runtime',
        work: {
          env: { ...env, ...launch.profile?.env },
          build: invocation.noBuild ? undefined : built,
          run: { assembly: runtimePathOf(built), args: [...(launch.profile?.args ?? []), ...invocation.appArgs], cwd: toMountPath(cwd) },
        },
      };
    }
  }
}

/** The plan as the host program's compile service reads it: runtime paths, reference files resolved from the manifest. */
export function compilePlan(planned: DotnetBuildPlan, references: Map<string, string>, manifest: DotnetBundleManifest, quiet = false): string {
  const files = new Set<string>();
  for (const group of planned.referenceGroups) for (const file of manifest.references[group]?.files ?? []) files.add(references.get(`${group}/${file.name}`)!);
  for (const id of planned.packages) for (const key of manifest.packages[id]?.references ?? []) if (references.has(key)) files.add(references.get(key)!);
  return JSON.stringify({
    projectFile: toMountPath(planned.projectFile),
    projectDir: toMountPath(planned.projectDir),
    assemblyName: planned.assemblyName,
    outputKind: planned.outputKind,
    outputPath: runtimePathOf(planned),
    sources: planned.sources.map(toMountPath),
    globalUsings: planned.globalUsings,
    references: [...files].filter(Boolean),
    nullable: planned.nullable,
    allowUnsafe: planned.allowUnsafe,
    langVersion: planned.langVersion,
    // Only a file-based program's leading `#:` directives are blanked before compiling.
    fileBased: planned.fileBased,
    defines: planned.defines,
    optimize: planned.optimize,
    warningsAsErrors: planned.warningsAsErrors,
    noWarn: planned.noWarn,
    quiet,
  });
}

/** Build (when asked), then run (when asked): the exit code. */
export async function runWithRuntime(work: RuntimeWork, loaded: LoadedDotnet, io: DotnetIo): Promise<number> {
  if (work.build) {
    const planned = work.build;
    for (const note of planned.notes) io.stdout(`  ${note}\n`);
    const groups = [...planned.referenceGroups, ...planned.packages.flatMap((id) => (loaded.manifest.packages[id]?.references ?? []).map((key) => key.split('/')[0]!))];
    const references = await loaded.mountReferences(groups);
    const code = await loaded.exports.Build(compilePlan(planned, references, loaded.manifest, !!work.run));
    if (code !== 0) {
      if (work.run) io.stderr('\nThe build failed. Fix the build errors and run again.\n');
      return code;
    }
  }
  if (!work.run) return 0;
  return loaded.exports.Run(work.run.assembly, work.run.args, work.run.cwd);
}
