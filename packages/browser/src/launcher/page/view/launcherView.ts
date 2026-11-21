/**
 * The launcher page's layout: the header across the top; the preview and logs in
 * the main column; services and issues beside it (stacked under it on a narrow
 * screen — see launcher.css). `update(services)` answers every service change: the
 * list, the log filter and the preview (the default, or the service chosen on its card).
 */
import type { ServiceSnapshot } from '../../../app/types.js';
import { formatLabel, type LauncherLabels } from '../../labels.js';
import { buildDiagnosticsReport } from '../diagnosticsReport.js';
import { createPreviewSelection } from '../previewTarget.js';
import { createCopyButton } from './copyButton.js';
import { el } from './dom.js';
import { createHeaderBar } from './headerBar.js';
import { createLogPanel } from './logPanel.js';
import { createPreviewPanel } from './previewPanel.js';
import { createProblemsPanel } from './problemsPanel.js';
import { createServicesPanel, type ServicesPanelActions } from './servicesPanel.js';

export function createLauncherView(container: HTMLElement, labels: LauncherLabels, actions: ServicesPanelActions) {
  const header = createHeaderBar(labels);
  const preview = createPreviewPanel(labels);
  // "Copy diagnostics" reads every panel's state at the moment of the click.
  const copy = createCopyButton({ idle: labels.copyDiagnostics, copied: labels.copyDiagnosticsDone, failed: labels.copyDiagnosticsFailed }, () => {
    const { summary, messages } = problems.snapshot();
    return buildDiagnosticsReport({
      now: new Date(),
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      ...header.snapshot(),
      ...(summary ? { summary } : {}),
      services: services.current(),
      problems: messages,
      logs: logs.allLines(),
    });
  });
  const logs = createLogPanel(labels, [copy]);
  const selection = createPreviewSelection();
  const services = createServicesPanel(labels, {
    // Restarting the previewed service stops it first: the hold keeps the preview's choice through that stop.
    restart: (serviceId) => {
      selection.holdThroughRestart(serviceId);
      actions.restart(serviceId);
    },
    showLogs: (serviceId) => {
      logs.show(serviceId);
      actions.showLogs(serviceId);
    },
    select: (serviceId) => {
      selection.select(serviceId);
      update(services.current());
    },
  });
  const problems = createProblemsPanel(labels);
  container.replaceChildren(
    header.root,
    el('main', { className: 'bf-layout' }, [
      el('div', { className: 'bf-column bf-column-main' }, [preview.root, logs.root]),
      el('div', { className: 'bf-column bf-column-side' }, [services.root, problems.root]),
    ]),
  );

  function update(list: readonly ServiceSnapshot[]): void {
    const { target, waiting, lost } = selection.resolve(list);
    const note = waiting
      ? formatLabel(labels.previewSelectionWaiting, { service: waiting })
      : lost
        ? formatLabel(labels.previewSelectionLost, { service: lost })
        : undefined;
    preview.show(target?.url, target?.id, note);
    services.render(list, target?.id);
    logs.setServices(list.map((service) => service.id));
  }

  return { header, preview, logs, services, problems, update };
}

export type LauncherView = ReturnType<typeof createLauncherView>;
