/**
 * What the launcher page decides before it boots anything — pure, so every
 * decision is tested without a browser:
 *
 * - an http launcher (`tls: false`) → blocked: applications run only on https preview origins;
 * - no manifest → blocked, "run /manifest init";
 * - an unversioned (legacy) `builderforce.json` → blocked, "an older format";
 * - a manifest with errors (or an unknown environment) → blocked, every issue listed;
 * - a service the browser cannot run here (.NET without its runtime bundle) → blocked
 *   as declined, with the reason — never a half-started application;
 * - otherwise ready: the `ApplicationSpec` for the environment, with every warning and
 *   every declined resource (the app runs without it) listed.
 */
import type { ApplicationSpec } from '@seanhogg/builderforce-webcontainers-core/app';
import {
  describeManifestIssue, environmentsOf, parseManifest, toApplicationSpec, type AppManifest, type EnvironmentTier, type ManifestIssue,
} from '@seanhogg/builderforce-webcontainers-core/manifest';
import { formatLabel, type LauncherLabels } from '../labels.js';
import type { LaunchInfo } from '../protocol.js';

export type PlanSeverity = 'error' | 'warning' | 'info';

export interface PlanMessage {
  severity: PlanSeverity;
  kind: 'issue' | 'declined' | 'skipped';
  /** What it is about: a manifest path, a resource or service id, a file. */
  subject?: string;
  text: string;
}

export interface LaunchHeader {
  name: string;
  environment: string | null;
  tier: EnvironmentTier | null;
  target: string | null;
}

export type BlockedReason = 'no-manifest' | 'legacy' | 'invalid' | 'declined' | 'insecure';

export type LaunchPlan =
  | { kind: 'blocked'; reason: BlockedReason; header: LaunchHeader; summary: string; messages: PlanMessage[] }
  | { kind: 'ready'; header: LaunchHeader; spec: ApplicationSpec; messages: PlanMessage[] };

/** The project's name for the header: the manifest's, else its directory's. */
function projectName(info: LaunchInfo, manifest: AppManifest | null): string {
  if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
  const segments = info.manifestPath.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 2] ?? info.projectId;
}

/** The environment to run when none was asked for: the first one targeting the browser, else the first declared. */
export function defaultEnvironment(manifest: AppManifest): string {
  const environments = Object.entries(environmentsOf(manifest));
  return (environments.find(([, environment]) => environment?.target === 'browser') ?? environments[0])?.[0] ?? 'local';
}

function issueMessage(issue: ManifestIssue): PlanMessage {
  return { severity: issue.severity, kind: 'issue', ...(issue.path ? { subject: issue.path } : {}), text: describeManifestIssue(issue) };
}

export function planLaunch(info: LaunchInfo, labels: LauncherLabels): LaunchPlan {
  const blank: LaunchHeader = { name: projectName(info, null), environment: info.environment, tier: null, target: null };
  // The runtime runs applications only on https preview origins (no http exception): an http launcher (`tls: false`) boots nothing.
  if (!info.relayUrl.startsWith('https:') || !info.previewOriginTemplate.startsWith('https:')) {
    return { kind: 'blocked', reason: 'insecure', header: blank, summary: labels.insecureLauncher, messages: [] };
  }
  if (info.manifestText === null) return { kind: 'blocked', reason: 'no-manifest', header: blank, summary: labels.noManifest, messages: [] };

  const parsed = parseManifest(info.manifestText);
  if (parsed.legacy) return { kind: 'blocked', reason: 'legacy', header: blank, summary: labels.legacyManifest, messages: parsed.issues.map(issueMessage) };
  const manifest = parsed.manifest;
  if (!manifest) return { kind: 'blocked', reason: 'invalid', header: blank, summary: labels.invalidManifest, messages: parsed.issues.map(issueMessage) };

  const environmentName = info.environment ?? defaultEnvironment(manifest);
  const result = toApplicationSpec(manifest, environmentName, { projectId: info.projectId });
  const header: LaunchHeader = {
    name: projectName(info, manifest),
    environment: result.environment?.name ?? environmentName,
    tier: result.environment?.tier ?? null,
    target: result.environment?.target ?? null,
  };
  const messages: PlanMessage[] = [
    ...result.issues.map(issueMessage),
    ...result.declined.map((declined): PlanMessage => ({ severity: 'warning', kind: 'declined', subject: declined.id, text: declined.reason })),
  ];
  if (!result.spec) return { kind: 'blocked', reason: 'invalid', header, summary: labels.invalidManifest, messages };

  // .NET services need the runtime bundle; without it they are declined here, with the server's reason.
  if (info.dotnet.bundleUrl === null) {
    const reason = formatLabel(labels.dotnetDeclined, { reason: info.dotnet.reason });
    const dotnet = result.spec.services.filter((service) => service.runtime === 'dotnet');
    if (dotnet.length > 0) {
      const declined = dotnet.map((service): PlanMessage => ({ severity: 'error', kind: 'declined', subject: service.id, text: reason }));
      return { kind: 'blocked', reason: 'declined', header, summary: labels.declinedServices, messages: [...declined, ...messages] };
    }
  }
  return { kind: 'ready', header, spec: result.spec, messages };
}

/** A service as the preview chooses among them. */
export interface PreviewCandidate {
  id: string;
  role?: string;
  url?: string;
}

/** The service the preview frame shows: the first `frontend` with a URL, else the first service with one. */
export function primaryServiceOf<T extends PreviewCandidate>(services: readonly T[]): T | undefined {
  return services.find((service) => service.role === 'frontend' && service.url) ?? services.find((service) => service.url);
}
