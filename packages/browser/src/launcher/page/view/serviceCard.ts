/**
 * One service's card: its state, port, restarts and last error, with Restart and Logs.
 * A previewable card (see `previewTarget.ts`) is also the preview's switch: its head is
 * a toggle button (`aria-pressed`, Enter/Space), and a click anywhere on the card
 * outside its buttons does the same. Restart and Logs never switch the preview.
 * Every button carries `data-focus` so the panel can put focus back after a re-render.
 */
import type { ServiceSnapshot } from '../../../app/types.js';
import { formatLabel, type LauncherLabels } from '../../labels.js';
import { el } from './dom.js';

export interface ServiceCardOptions {
  labels: LauncherLabels;
  /** The preview shows this service. */
  previewing: boolean;
  /** Present when the service is previewable: show it in the preview. */
  select?: () => void;
  restart(): void;
  showLogs(): void;
}

export function createServiceCard(service: ServiceSnapshot, options: ServiceCardOptions): HTMLLIElement {
  const { labels, previewing, select } = options;
  const restart = el('button', { className: 'bf-button', attrs: { type: 'button', 'data-focus': `${service.id}:restart` }, text: labels.restart });
  restart.addEventListener('click', () => options.restart());
  const logs = el('button', { className: 'bf-button bf-button-quiet', attrs: { type: 'button', 'data-focus': `${service.id}:logs` }, text: labels.showLogs });
  logs.addEventListener('click', () => options.showLogs());

  const headParts = [
    el('strong', { text: service.id }),
    el('span', { className: 'bf-chip', text: service.runtime }),
    el('span', { className: `bf-state bf-state-${service.state}`, text: service.state }),
  ];
  let head: HTMLElement;
  if (select) {
    head = el(
      'button',
      {
        className: 'bf-service-head bf-service-select',
        attrs: { type: 'button', 'aria-pressed': String(previewing), title: formatLabel(labels.previewService, { service: service.id }), 'data-focus': `${service.id}:select` },
      },
      [...headParts, el('span', { className: 'bf-chip bf-preview-mark', text: previewing ? labels.previewing : labels.previewAction })],
    );
    head.addEventListener('click', select);
  } else {
    head = el('div', { className: 'bf-service-head' }, headParts);
  }

  const attrs: Record<string, string> = { 'data-state': service.state };
  if (select) attrs['data-previewable'] = 'true';
  if (previewing) {
    attrs['data-previewing'] = 'true';
    attrs['aria-current'] = 'true';
  }
  const card = el('li', { className: 'bf-service', attrs }, [
    head,
    el('div', { className: 'bf-service-meta' }, [
      service.port !== undefined && el('span', { text: formatLabel(labels.port, { port: service.port }) }),
      el('span', { text: formatLabel(labels.restarts, { count: service.restarts }) }),
    ]),
    service.error && el('p', { className: 'bf-service-error', text: `${service.error.phase}: ${service.error.message}` }),
    el('div', { className: 'bf-actions' }, [restart, logs]),
  ]);
  // A pointer click on the card's body (not on one of its buttons or links, and not the end of a text selection — copying an
  // error) selects too; keyboard users have the head button.
  if (select) {
    card.addEventListener('click', (event) => {
      const target = event.target as Element | null;
      if (target?.closest('button, a')) return;
      if (typeof getSelection === 'function' && (getSelection()?.toString() ?? '') !== '') return;
      select();
    });
  }
  return card;
}
