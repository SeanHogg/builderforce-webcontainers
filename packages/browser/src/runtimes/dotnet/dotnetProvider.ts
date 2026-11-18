/**
 * The `dotnet` runtime provider for `startApplicationRuntime`: a service whose
 * command is `dotnet` (`dotnet run`, `dotnet run --project api`, `dotnet
 * api.dll`, `dotnet run app.cs`) runs as a .NET process of the runtime — the
 * process host gives `dotnet` commands a .NET Worker — and is held to the same
 * readiness as a Node service (its port opening, a health URL, a clean exit):
 * the Node provider's start is reused as is. What it cannot run it declines
 * with a reason: other commands, `dotnet` verbs the runtime refuses, and —
 * given the project's files — projects it cannot build (an unsupported SDK or
 * target framework, project references, NuGet packages the bundle does not
 * carry), so the host can send the application to the container target.
 */
import { readinessOf, type Acceptance, type RuntimeProvider, type ServiceSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import type { VirtualFileSystem } from '@seanhogg/builderforce-webcontainers-core';
import { createNodeProvider, type NodeProviderOptions } from '../../app/nodeProvider.js';
import type { NodeServiceHost } from '../../app/nodeReadiness.js';
import { resolveFrom } from '../python/requirements.js';
import { findProject, planBuild } from './dotnetBuildPlan.js';
import { isDotnetCommand, parseDotnetCommand } from './dotnetCommand.js';

export interface DotnetProviderOptions extends NodeProviderOptions {
  /** The project's files: with them, a project the runtime cannot build is declined up front, with the reason. */
  fs?: VirtualFileSystem;
}

export function acceptsDotnetService(service: ServiceSpec, fs?: VirtualFileSystem): Acceptance {
  if (service.type !== 'application') return { ok: false, reason: `The dotnet runtime runs application services; "${service.id}" is a ${service.type} service.` };
  if (readinessOf(service).kind === 'query') return { ok: false, reason: `"query" readiness is for databases; service "${service.id}" runs on dotnet.` };
  const command = service.command;
  if (!command || !isDotnetCommand(command)) return { ok: false, reason: `Service "${service.id}": "${command ?? ''}" is not a dotnet command.` };
  const parsed = parseDotnetCommand(command, service.args ?? []);
  if (!parsed.ok) return { ok: false, reason: `Service "${service.id}": ${parsed.reason}` };
  const { invocation } = parsed;
  if (!fs || (invocation.kind !== 'run' && invocation.kind !== 'build')) return { ok: true };
  const root = resolveFrom('/', service.root ?? '/');
  const configuration = invocation.configuration;
  let path: string;
  if (invocation.kind === 'run' && invocation.file) path = resolveFrom(root, invocation.file);
  else {
    const found = findProject(fs, root, invocation.project, invocation.kind);
    if (!found.ok) return { ok: false, reason: `Service "${service.id}": ${found.reason}` };
    path = found.path;
  }
  const planned = planBuild(fs, path, configuration);
  if (!planned.ok) return { ok: false, reason: `Service "${service.id}": ${planned.reason}` };
  if (invocation.kind === 'run' && planned.plan.outputKind !== 'exe') return { ok: false, reason: `Service "${service.id}": ${planned.plan.projectFile} is a class library; it cannot run.` };
  return { ok: true };
}

/** `host` is the runtime (`startPreviewRuntime()`'s, or a `ProcessHost` adapted): it runs `dotnet` commands in .NET Workers. */
export function createDotnetProvider(host: NodeServiceHost, options: DotnetProviderOptions = {}): RuntimeProvider {
  const { start } = createNodeProvider(host, options);
  return {
    id: 'dotnet',
    accepts: (service) => acceptsDotnetService(service, options.fs),
    start,
  };
}
