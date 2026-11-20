/**
 * Boot a ready launch plan: the preview runtime in RELAY mode (the relay on the
 * shared loopback origin, one `{key}.localhost` origin per application, database
 * Workers on the host page's origin), the project's files written into it, and
 * the application runtime over every provider — the way Builderforce's browser
 * run target does (`frontend/src/lib/runTarget/browserRunTarget.ts`).
 *
 * The runtime modules come in through {@link BootDeps} (`runtimeDeps.ts` in the
 * page), so this file holds only the wiring and is tested with them mocked.
 */
import type { RuntimeProvider } from '@seanhogg/builderforce-webcontainers-core/app';
import type { FileTree } from '@seanhogg/builderforce-webcontainers-core';
import type { ApplicationRuntime, ApplicationRuntimeOptions, PhpHostOptions } from '../../app.js';
import type { PreviewOriginOption } from '../../previewOrigin.js';
import type { PreviewRuntime, PreviewRuntimeOptions } from '../../runtimeOptions.js';
import { LAUNCH_PROJECT_ROOT, type LaunchInfo, type ProjectSnapshot } from '../protocol.js';
import type { LaunchPlan } from './launchPlan.js';

export interface BootDeps {
  startPreviewRuntime(options: PreviewRuntimeOptions): Promise<PreviewRuntime>;
  previewOriginTemplate(template: string): PreviewOriginOption;
  startApplicationRuntime(spec: Extract<LaunchPlan, { kind: 'ready' }>['spec'], options: ApplicationRuntimeOptions): ApplicationRuntime;
  /** Every provider, over the booted runtime. */
  providers(runtime: PreviewRuntime): RuntimeProvider[];
  /** The ONE PHP options object: given to the runtime and to the `php` provider, so both judge the same PHP. */
  phpOptions: PhpHostOptions;
}

export interface BootedApplication {
  runtime: PreviewRuntime;
  application: ApplicationRuntime;
}

/** Base64 to bytes (the page has `atob`; so does Node ≥ 16). */
export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The snapshot as a flat file tree (text as strings, the rest as bytes). */
export function snapshotTree(snapshot: ProjectSnapshot): FileTree {
  const tree: FileTree = { ...snapshot.files };
  for (const [path, base64] of Object.entries(snapshot.binary)) tree[path] = decodeBase64(base64);
  return tree;
}

/** The runtime's options for this launch. */
export function runtimeOptionsFor(info: LaunchInfo, deps: Pick<BootDeps, 'previewOriginTemplate' | 'phpOptions'>): PreviewRuntimeOptions {
  return {
    relayUrl: info.relayUrl,
    previewOrigin: deps.previewOriginTemplate(info.previewOriginTemplate),
    id: info.projectId,
    root: LAUNCH_PROJECT_ROOT,
    node: { workerUrl: info.hostWorkerUrl },
    php: deps.phpOptions,
    ...(info.dotnet.bundleUrl ? { dotnet: { bundleUrl: info.dotnet.bundleUrl } } : {}),
  };
}

/** Boot the runtime, write the files and create the application (not started: the caller starts it and shows progress). */
export async function bootApplication(
  plan: Extract<LaunchPlan, { kind: 'ready' }>,
  info: LaunchInfo,
  snapshot: ProjectSnapshot,
  deps: BootDeps,
): Promise<BootedApplication> {
  const runtime = await deps.startPreviewRuntime(runtimeOptionsFor(info, deps));
  try {
    runtime.writeTree(snapshotTree(snapshot));
    const application = deps.startApplicationRuntime(plan.spec, { runtime, providers: deps.providers(runtime) });
    return { runtime, application };
  } catch (error) {
    runtime.dispose();
    throw error;
  }
}
