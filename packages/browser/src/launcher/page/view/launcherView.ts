/**
 * The launcher page's layout: the header across the top; the preview and logs in
 * the main column; services and issues beside it (stacked under it on a narrow
 * screen — see launcher.css).
 */
import type { LauncherLabels } from '../../labels.js';
import { buildDiagnosticsReport } from '../diagnosticsReport.js';
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
  const services = createServicesPanel(labels, {
    restart: actions.restart,
    showLogs: (serviceId) => {
      logs.show(serviceId);
      actions.showLogs(serviceId);
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
  return { header, preview, logs, services, problems };
}

export type LauncherView = ReturnType<typeof createLauncherView>;
