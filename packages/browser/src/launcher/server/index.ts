/**
 * `@seanhogg/builderforce-webcontainers/launcher/server` — the local launcher
 * (Node only): `createLocalLauncher({ projectDir })` serves a loopback https URL that
 * runs the project's `builderforce.json` application in a normal browser. Never
 * imported by the browser entry points.
 *
 * Trusting the local CA (so the browser does not warn): `caTrustCommand(launcher.ca)`
 * (or `caTrustCommand(await loadOrCreateLocalCa(defaultCaStoreDir()))` before a launch)
 * gives the command to run after the user approves it; `caTrustCheckCommand` asks
 * whether it already is trusted.
 */
export { createLocalLauncher, defaultCaStoreDir } from './launcher.js';
export type { LocalLauncher, LocalLauncherOptions } from './launcher.js';
export type { LauncherForwardAi } from './aiRelay.js';
export { isLaunchPageError, LaunchPageError } from './launchPage.js';
export type { LaunchPageErrorCode } from './launchPage.js';
export { CA_COMMON_NAME, loadOrCreateLocalCa } from './tls/localCa.js';
export type { LocalCa } from './tls/localCa.js';
export { caTrustCheckCommand, caTrustCommand, caThumbprint } from './tls/trust.js';
export type { TrustCommand, TrustPlan } from './tls/trust.js';
export { DEFAULT_LAUNCHER_LABELS } from '../labels.js';
export type { LauncherLabels } from '../labels.js';
export { EXCLUDED_DIRECTORIES, LAUNCH_PATHS, LAUNCH_TOKEN_HEADER, PROJECT_LIMITS } from '../protocol.js';
export type { LaunchInfo, ProjectChange, ProjectSnapshot } from '../protocol.js';
