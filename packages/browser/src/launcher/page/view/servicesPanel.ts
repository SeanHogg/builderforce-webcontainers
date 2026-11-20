/** The services list: each service's state, port, restarts and last error, with Restart and Logs buttons. */
import type { ServiceSnapshot } from '../../../app/types.js';
import { formatLabel, type LauncherLabels } from '../../labels.js';
import { el, replaceChildren } from './dom.js';

export interface ServicesPanelActions {
  restart(serviceId: string): void;
  showLogs(serviceId: string): void;
}

export function createServicesPanel(labels: LauncherLabels, actions: ServicesPanelActions) {
  const list = el('ul', { className: 'bf-services' });
  const root = el('section', { className: 'bf-panel', attrs: { 'aria-label': labels.services } }, [el('h2', { text: labels.services }), list]);
  replaceChildren(list, [el('li', { className: 'bf-empty', text: labels.notStarted })]);

  function card(service: ServiceSnapshot): HTMLLIElement {
    const restart = el('button', { className: 'bf-button', attrs: { type: 'button' }, text: labels.restart });
    restart.addEventListener('click', () => actions.restart(service.id));
    const logs = el('button', { className: 'bf-button bf-button-quiet', attrs: { type: 'button' }, text: labels.showLogs });
    logs.addEventListener('click', () => actions.showLogs(service.id));
    return el('li', { className: 'bf-service', attrs: { 'data-state': service.state } }, [
      el('div', { className: 'bf-service-head' }, [
        el('strong', { text: service.id }),
        el('span', { className: 'bf-chip', text: service.runtime }),
        el('span', { className: `bf-state bf-state-${service.state}`, text: service.state }),
      ]),
      el('div', { className: 'bf-service-meta' }, [
        service.port !== undefined && el('span', { text: formatLabel(labels.port, { port: service.port }) }),
        el('span', { text: formatLabel(labels.restarts, { count: service.restarts }) }),
      ]),
      service.error && el('p', { className: 'bf-service-error', text: `${service.error.phase}: ${service.error.message}` }),
      el('div', { className: 'bf-actions' }, [restart, logs]),
    ]);
  }

  return {
    root,
    render(services: readonly ServiceSnapshot[]): void {
      replaceChildren(list, services.length > 0 ? services.map(card) : [el('li', { className: 'bf-empty', text: labels.noServices })]);
    },
  };
}

export type ServicesPanel = ReturnType<typeof createServicesPanel>;
