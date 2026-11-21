/**
 * Every string the launcher page shows, in ONE object: English by default, each
 * one replaceable through `createLocalLauncher({ labels })` (served in
 * `launch.json`). `{name}` placeholders are filled by {@link formatLabel}.
 */
export interface LauncherLabels {
  title: string;
  loading: string;
  loadingFiles: string;
  bootingRuntime: string;
  startingServices: string;
  running: string;
  notStarted: string;
  startFailed: string;
  environment: string;
  target: string;
  tierProduction: string;
  tierNonProduction: string;
  services: string;
  noServices: string;
  /** The services filter's group name. */
  servicesFilter: string;
  /** The filter showing services that are up, on their way, or failed (the default). */
  servicesFilterRunning: string;
  /** The filter showing every service. `{count}` is how many there are. */
  servicesFilterAll: string;
  /** Under the Running filter: how many finished or stopped services are hidden. `{count}`. */
  servicesHidden: string;
  /** The button beside `servicesHidden` that switches to the All filter. */
  servicesShowAll: string;
  /** The Running filter with nothing to show (every service finished or stopped). */
  noRunningServices: string;
  /** The affordance on a service card that shows it in the preview. */
  previewAction: string;
  /** The mark on the card the preview shows. */
  previewing: string;
  /** A previewable card's tooltip. `{service}`. */
  previewService: string;
  /** The chosen service stopped or failed for good, or is gone; the preview went back to the default. `{service}`. */
  previewSelectionLost: string;
  /** The chosen service is not serving right now (restarting); the default shows until it is. `{service}`. */
  previewSelectionWaiting: string;
  port: string;
  restarts: string;
  restart: string;
  showLogs: string;
  logs: string;
  logsAll: string;
  logsDropped: string;
  noLogs: string;
  copyDiagnostics: string;
  copyDiagnosticsDone: string;
  copyDiagnosticsFailed: string;
  preview: string;
  openInNewTab: string;
  noPreview: string;
  /** A preview tab or frame no service worker serves yet (the preview origin's bootstrap page). */
  previewStarting: string;
  /** The bootstrap gave up: no launcher tab runs this preview. */
  previewNotRunning: string;
  /** `/preview?src=` named something that is not one of this launcher's previews. */
  previewInvalid: string;
  problems: string;
  noProblems: string;
  declined: string;
  severityError: string;
  severityWarning: string;
  severityInfo: string;
  noManifest: string;
  legacyManifest: string;
  /** A root manifest from an older version: read, with this notice. `{path}` is where it is. */
  legacyManifestLocation: string;
  /** The manifest resolves outside the project and was not read. `{path}` is where it is. */
  manifestOutsideProject: string;
  /** A manifest is there but could not be read. `{path}`, `{reason}`. */
  manifestUnreadable: string;
  invalidManifest: string;
  declinedServices: string;
  dotnetDeclined: string;
  skippedFile: string;
  liveSyncStopped: string;
  missingToken: string;
  insecureLauncher: string;
  originsUnreachable: string;
}

export const DEFAULT_LAUNCHER_LABELS: Readonly<LauncherLabels> = Object.freeze({
  title: 'Builderforce launcher',
  loading: 'Loading the project…',
  loadingFiles: 'Reading the project files…',
  bootingRuntime: 'Starting the in-browser runtime…',
  startingServices: 'Starting services…',
  running: 'Running',
  notStarted: 'Not started',
  startFailed: 'Could not start: {message}',
  environment: 'Environment',
  target: 'Target',
  tierProduction: 'Production',
  tierNonProduction: 'Non-production',
  services: 'Services',
  noServices: 'No services.',
  servicesFilter: 'Show services',
  servicesFilterRunning: 'Running',
  servicesFilterAll: 'All ({count})',
  servicesHidden: '{count} hidden: finished setup steps or stopped services.',
  servicesShowAll: 'Show all',
  noRunningServices: 'No service is running.',
  previewAction: 'Preview',
  previewing: 'In preview',
  previewService: 'Show {service} in the preview',
  previewSelectionLost: '{service} is no longer serving, so the preview went back to the default service.',
  previewSelectionWaiting: '{service} is not serving right now; the preview returns to it when it is.',
  port: 'Port {port}',
  restarts: 'Restarts: {count}',
  restart: 'Restart',
  showLogs: 'Logs',
  logs: 'Logs',
  logsAll: 'All services',
  logsDropped: '{count} earlier lines dropped',
  noLogs: 'No output yet.',
  copyDiagnostics: 'Copy diagnostics',
  copyDiagnosticsDone: 'Copied',
  copyDiagnosticsFailed: 'Copy failed',
  preview: 'Preview',
  openInNewTab: 'Open in new tab',
  noPreview: 'No service serves a page yet.',
  previewStarting: 'Starting the preview…',
  previewNotRunning: 'This preview is not running. Keep the launcher tab open, or start the project again with bfwc-launch.',
  previewInvalid: 'That address is not a preview of this launcher.',
  problems: 'Issues and declines',
  noProblems: 'No issues.',
  declined: 'Declined',
  severityError: 'Error',
  severityWarning: 'Warning',
  severityInfo: 'Info',
  noManifest: 'This project has no builderforce.json. Run /manifest init to create one.',
  legacyManifest: 'This builderforce.json is an older format; run /manifest init.',
  legacyManifestLocation: 'The manifest at {path} is in the old location. Move it to .builderforce/builderforce.json (/manifest move); the root file is still read for now, never written.',
  manifestOutsideProject: 'The manifest at {path} resolves outside the project (a link), so it was not read.',
  manifestUnreadable: 'The manifest at {path} could not be read: {reason}',
  invalidManifest: 'builderforce.json has errors, so nothing was started.',
  declinedServices: 'Some services cannot run in the browser, so nothing was started.',
  dotnetDeclined: 'The .NET runtime bundle is not available: {reason}',
  skippedFile: 'Not loaded (over a size cap, or outside the project): {path}',
  liveSyncStopped: 'Live sync stopped: {message}',
  missingToken: 'This launch link has no token. Open the exact link the launcher printed.',
  insecureLauncher: 'This launcher serves plain http, and the runtime runs applications only on https preview origins. Start the launcher with https (the default).',
  originsUnreachable:
    'The preview origin {origin} could not be reached ({detail}). Trust the launcher’s local CA (bfwc-launch --trust prints the step) and use Chromium or Firefox: Safari may not resolve *.localhost names.',
});

/** The defaults with `overrides` on top; anything that is not a string is ignored. */
export function resolveLabels(overrides: Partial<Record<keyof LauncherLabels, unknown>> | undefined): LauncherLabels {
  const labels: LauncherLabels = { ...DEFAULT_LAUNCHER_LABELS };
  if (!overrides || typeof overrides !== 'object') return labels;
  for (const key of Object.keys(DEFAULT_LAUNCHER_LABELS) as (keyof LauncherLabels)[]) {
    const value = overrides[key];
    if (typeof value === 'string') labels[key] = value;
  }
  return labels;
}

/** `template` with each `{name}` replaced by `values[name]` (unknown names stay as written). */
export function formatLabel(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : match));
}
