/**
 * The launcher page (`dist/launcher/page.js`, served by `createLocalLauncher`):
 * reads the launch (token from the URL fragment), decides what it can run
 * (`launchPlan.ts`), boots the runtime and the application (`bootApplication.ts`),
 * keeps the runtime's files in step with the disk (`liveSync.ts`), and shows each
 * service's state and logs, the primary frontend in a frame, and every issue and
 * decline (`view/`).
 */
import type { ApplicationRuntime, ServiceLogEntry } from '../../app/types.js';
import { DEFAULT_LAUNCHER_LABELS, formatLabel, resolveLabels, type LauncherLabels } from '../labels.js';
import type { LaunchInfo } from '../protocol.js';
import { bootApplication } from './bootApplication.js';
import { createLaunchClient, readLaunchToken, type LaunchClient } from './launchConfig.js';
import { planLaunch, primaryServiceOf } from './launchPlan.js';
import { probeOrigins } from './originProbe.js';
import { startLiveSync } from './liveSync.js';
import { runtimeDeps } from './runtimeDeps.js';
import { createLauncherView, type LauncherView } from './view/launcherView.js';
import type { LogPanel } from './view/logPanel.js';

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function pumpLogs(stream: ReadableStream<ServiceLogEntry>, logs: LogPanel): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    logs.append(value);
  }
}

async function run(client: LaunchClient, info: LaunchInfo, view: LauncherView, labels: LauncherLabels, hold: { application?: ApplicationRuntime }): Promise<void> {
  const plan = planLaunch(info, labels);
  view.header.setHeader(plan.header);
  view.problems.add(...plan.messages);
  if (plan.kind === 'blocked') {
    view.problems.setSummary(plan.summary);
    view.header.setStatus(plan.summary, 'error');
    return;
  }

  // The preview origins must resolve and be trusted before anything boots on them.
  const unreachable = await probeOrigins(info, (input, init) => fetch(input, init));
  if (unreachable) {
    const summary = formatLabel(labels.originsUnreachable, { origin: unreachable.origin, detail: unreachable.detail });
    view.problems.setSummary(summary);
    view.header.setStatus(summary, 'error');
    return;
  }

  view.header.setStatus(labels.loadingFiles);
  const snapshot = await client.files();
  view.problems.add(...snapshot.skipped.map((path) => ({ severity: 'warning' as const, kind: 'skipped' as const, subject: path, text: formatLabel(labels.skippedFile, { path }) })));

  view.header.setStatus(labels.bootingRuntime);
  const { runtime, application } = await bootApplication(plan, info, snapshot, runtimeDeps);
  hold.application = application;
  const refresh = () => {
    const services = application.listServices();
    view.services.render(services);
    view.logs.setServices(services.map((service) => service.id));
    const primary = primaryServiceOf(services);
    view.preview.show(primary?.url, primary?.id);
  };
  application.onStateChange(refresh);
  application.onError(refresh);
  refresh();
  void pumpLogs(application.logs(), view.logs).catch((error: unknown) => view.problems.add({ severity: 'warning', kind: 'issue', text: messageOf(error) }));

  const stopSync = startLiveSync(client, runtime.fs, {
    skipped: (path) => view.problems.add({ severity: 'warning', kind: 'skipped', subject: path, text: formatLabel(labels.skippedFile, { path }) }),
    error: (message) => view.problems.add({ severity: 'warning', kind: 'issue', text: formatLabel(labels.liveSyncStopped, { message }) }),
  });
  addEventListener('pagehide', () => {
    stopSync();
    void application.dispose().finally(() => runtime.dispose());
  });

  view.header.setStatus(labels.startingServices);
  try {
    await application.start();
    view.header.setStatus(labels.running, 'ok');
  } catch (error) {
    view.header.setError(messageOf(error));
  } finally {
    refresh();
  }
}

async function main(): Promise<void> {
  const container = document.getElementById('app') ?? document.body;
  const token = readLaunchToken(location.hash);
  // The token leaves the address bar (and the history entry) as soon as it is read.
  history.replaceState(null, '', location.pathname + location.search);
  if (!token) {
    container.textContent = DEFAULT_LAUNCHER_LABELS.missingToken;
    return;
  }
  const client = createLaunchClient(token);
  // Labels come with the launch; until it answers, the defaults speak.
  let info: LaunchInfo;
  try {
    info = await client.launch();
  } catch (error) {
    container.textContent = formatLabel(DEFAULT_LAUNCHER_LABELS.startFailed, { message: messageOf(error) });
    return;
  }
  const labels = resolveLabels(info.labels);
  const hold: { application?: ApplicationRuntime } = {};
  const view = createLauncherView(container, labels, {
    restart: (serviceId) =>
      void hold.application?.restart(serviceId).catch((error: unknown) => view.problems.add({ severity: 'error', kind: 'issue', subject: serviceId, text: messageOf(error) })),
    showLogs: () => undefined,
  });
  await run(client, info, view, labels, hold).catch((error: unknown) => view.header.setError(messageOf(error)));
}

void main();
