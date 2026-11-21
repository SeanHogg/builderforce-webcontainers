/**
 * The services list: one card per service (`serviceCard.ts`), filtered to the running
 * ones or all (`serviceFilter.ts`; the choice lasts for the page session), with a note
 * counting what the filter hides. A previewable card switches the preview.
 */
import type { ServiceSnapshot } from '../../../app/types.js';
import { formatLabel, type LauncherLabels } from '../../labels.js';
import { isPreviewable } from '../previewTarget.js';
import { filterServices, readServiceFilter, writeServiceFilter, type ServiceFilter } from '../serviceFilter.js';
import { el, replaceChildren } from './dom.js';
import { createServiceCard } from './serviceCard.js';

export interface ServicesPanelActions {
  restart(serviceId: string): void;
  showLogs(serviceId: string): void;
}

export interface ServicesPanelOptions extends ServicesPanelActions {
  /** Show `serviceId` in the preview. */
  select(serviceId: string): void;
}

const sessionStore = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

export function createServicesPanel(labels: LauncherLabels, actions: ServicesPanelOptions) {
  let filter: ServiceFilter = readServiceFilter(sessionStore);
  let shown: readonly ServiceSnapshot[] = [];
  let previewId: string | undefined;
  let started = false;

  const filterButton = (value: ServiceFilter) => {
    const button = el('button', { className: 'bf-button bf-button-quiet bf-segment', attrs: { type: 'button', 'data-focus': `filter:${value}` } });
    button.addEventListener('click', () => setFilter(value));
    return button;
  };
  const runningButton = filterButton('running');
  const allButton = filterButton('all');
  const list = el('ul', { className: 'bf-services' });
  const hiddenText = el('span');
  const showAll = el('button', { className: 'bf-button bf-button-quiet', attrs: { type: 'button', 'data-focus': 'filter:show-all' }, text: labels.servicesShowAll });
  showAll.addEventListener('click', () => setFilter('all'));
  const hiddenNote = el('p', { className: 'bf-note bf-services-hidden', attrs: { hidden: '' } }, [hiddenText, showAll]);
  const root = el('section', { className: 'bf-panel', attrs: { 'aria-label': labels.services } }, [
    el('div', { className: 'bf-panel-head' }, [
      el('h2', { text: labels.services }),
      el('div', { className: 'bf-segmented', attrs: { role: 'group', 'aria-label': labels.servicesFilter } }, [runningButton, allButton]),
    ]),
    list,
    hiddenNote,
  ]);

  function setFilter(next: ServiceFilter): void {
    filter = next;
    writeServiceFilter(sessionStore, next);
    draw();
  }

  /** The focused control's `data-focus` key, when focus is inside this panel. */
  function focusedKey(): string | null {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    return active && root.contains(active) ? active.getAttribute('data-focus') : null;
  }

  function refocus(key: string | null): void {
    if (!key) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-focus]')).find((node) => node.getAttribute('data-focus') === key && !node.closest('[hidden]'));
    // Gone ("Show all" hides itself once pressed; a card the filter now hides, or a service that left): focus moves
    // to the filter that is on — never lost to the page.
    (target ?? (filter === 'all' ? allButton : runningButton)).focus();
  }

  function draw(): void {
    const key = focusedKey();
    runningButton.textContent = labels.servicesFilterRunning;
    allButton.textContent = formatLabel(labels.servicesFilterAll, { count: shown.length });
    runningButton.setAttribute('aria-pressed', String(filter === 'running'));
    allButton.setAttribute('aria-pressed', String(filter === 'all'));

    const { shown: visible, hidden } = filterServices(shown, filter);
    const card = (service: ServiceSnapshot) =>
      createServiceCard(service, {
        labels,
        previewing: service.id === previewId,
        ...(isPreviewable(service) ? { select: () => actions.select(service.id) } : {}),
        restart: () => actions.restart(service.id),
        showLogs: () => actions.showLogs(service.id),
      });
    const empty = !started ? labels.notStarted : shown.length === 0 ? labels.noServices : labels.noRunningServices;
    replaceChildren(list, visible.length > 0 ? visible.map(card) : [el('li', { className: 'bf-empty', text: empty })]);
    hiddenText.textContent = formatLabel(labels.servicesHidden, { count: hidden.length });
    hiddenNote.hidden = hidden.length === 0;
    refocus(key);
  }

  draw();

  return {
    root,
    /** The services as last rendered (every one, whatever the filter shows). */
    current(): readonly ServiceSnapshot[] {
      return shown;
    },
    /** Render `services`, marking `preview` (the service the preview shows). */
    render(services: readonly ServiceSnapshot[], preview?: string): void {
      started = true;
      shown = [...services];
      previewId = preview;
      draw();
    },
  };
}

export type ServicesPanel = ReturnType<typeof createServicesPanel>;
