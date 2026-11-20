/**
 * The launcher page's layout: the header across the top; the preview and logs in
 * the main column; services and issues beside it (stacked under it on a narrow
 * screen — see launcher.css).
 */
import type { LauncherLabels } from '../../labels.js';
import { el } from './dom.js';
import { createHeaderBar } from './headerBar.js';
import { createLogPanel } from './logPanel.js';
import { createPreviewPanel } from './previewPanel.js';
import { createProblemsPanel } from './problemsPanel.js';
import { createServicesPanel, type ServicesPanelActions } from './servicesPanel.js';

export function createLauncherView(container: HTMLElement, labels: LauncherLabels, actions: ServicesPanelActions) {
  const header = createHeaderBar(labels);
  const preview = createPreviewPanel(labels);
  const logs = createLogPanel(labels);
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
