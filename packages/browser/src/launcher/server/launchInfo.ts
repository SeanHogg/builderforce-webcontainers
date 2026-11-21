/**
 * `/__bf/launch.json`: who the project is (a stable id from its directory), its
 * manifest as text (read fresh on every request, so an edit shows on reload), and
 * where the page's runtime finds its relay, preview origins, host worker and .NET
 * bundle. The page interprets the manifest itself (core's `parseManifest`): the
 * server never judges it.
 */
import { createHash } from 'node:crypto';
import { locateManifest, MANIFEST_FILE, manifestWritePath } from '../../manifest/locate.js';
import type { LauncherLabels } from '../labels.js';
import { DOTNET_BUNDLE_PREFIX, PREVIEW_SCRIPT_PREFIX, type LaunchInfo } from '../protocol.js';
import type { DotnetBundleSource } from './dotnetBundle.js';
import type { LauncherHosts } from './hosts.js';

export { MANIFEST_FILE };

/**
 * A stable project id for `projectDir` (its real path): `p` + 24 hex of SHA-256. It is
 * the runtime's `id`, so each application keeps its preview origin — and storage — across
 * launches. Windows paths are compared case-insensitively.
 */
export function projectIdOf(realProjectDir: string): string {
  const key = process.platform === 'win32' ? realProjectDir.toLowerCase() : realProjectDir;
  return `p${createHash('sha256').update(`bfwc-launcher\u0000${key}`).digest('hex').slice(0, 24)}`;
}

export interface LaunchInfoInput {
  root: string;
  projectId: string;
  hosts: LauncherHosts;
  environment?: string;
  manifestText?: string;
  dotnet: DotnetBundleSource;
  labels?: Partial<LauncherLabels>;
}

export async function buildLaunchInfo(input: LaunchInfoInput): Promise<LaunchInfo> {
  const located = input.manifestText === undefined ? await locateManifest(input.root) : null;
  const { hosts } = input;
  return {
    projectId: input.projectId,
    environment: input.environment ?? null,
    manifestText: input.manifestText ?? located?.text ?? null,
    manifestPath: located?.path ?? manifestWritePath(input.root),
    manifestSource: input.manifestText !== undefined ? 'override' : located?.source ?? 'missing',
    ...(located?.deprecation ? { deprecation: located.deprecation } : {}),
    relayUrl: `${hosts.relayOrigin}${PREVIEW_SCRIPT_PREFIX}relay.html`,
    previewOriginTemplate: hosts.appOriginTemplate,
    hostWorkerUrl: `${hosts.pageOrigin}${PREVIEW_SCRIPT_PREFIX}process-worker.js`,
    dotnet: input.dotnet.dir !== null ? { bundleUrl: `${hosts.relayOrigin}${DOTNET_BUNDLE_PREFIX}` } : { bundleUrl: null, reason: input.dotnet.reason },
    ...(input.labels ? { labels: input.labels } : {}),
  };
}
