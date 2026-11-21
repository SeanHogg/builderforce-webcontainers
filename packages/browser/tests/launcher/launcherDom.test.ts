// @vitest-environment jsdom
/**
 * The launcher page's service cards, services panel and view wiring, in a DOM (jsdom):
 * Restart/Logs never switch the preview, a card switches it once; focus survives a
 * re-render; the filter's hidden count and empty states; live updates leave the
 * preview frame alone; the preview notices.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceSnapshot } from '../../src/app/types.js';
import { DEFAULT_LAUNCHER_LABELS, formatLabel } from '../../src/launcher/labels.js';
import { previewPageHref } from '../../src/launcher/protocol.js';
import { SERVICE_FILTER_STORAGE_KEY } from '../../src/launcher/page/serviceFilter.js';
import { createLauncherView } from '../../src/launcher/page/view/launcherView.js';
import { createServiceCard } from '../../src/launcher/page/view/serviceCard.js';
import { createServicesPanel } from '../../src/launcher/page/view/servicesPanel.js';

const labels = DEFAULT_LAUNCHER_LABELS;

function service(id: string, overrides: Partial<ServiceSnapshot> = {}): ServiceSnapshot {
  return { id, type: 'application', runtime: 'node', role: 'backend', state: 'running', restarts: 0, ...overrides };
}

const db = service('db', { type: 'database', runtime: 'pglite', port: 5432 });
const installWeb = service('install-web', { state: 'stopped', exitCode: 0 });
const installApi = service('install-api', { state: 'stopped', exitCode: 0 });
const api = service('api', { port: 8000, url: 'https://api.preview.localhost/' });
const web = service('web', { role: 'frontend', port: 5173, url: 'https://web.preview.localhost/' });
const all = [db, installWeb, installApi, api, web];

const byFocus = (root: ParentNode, key: string) => root.querySelector<HTMLElement>(`[data-focus="${key}"]`);

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
  getSelection()?.removeAllRanges();
});

describe('serviceCard', () => {
  function mount(select = vi.fn()) {
    const restart = vi.fn();
    const showLogs = vi.fn();
    const card = createServiceCard(api, { labels, previewing: false, select, restart, showLogs });
    document.body.append(card);
    return { card, select, restart, showLogs };
  }

  it('Restart and Logs never select', () => {
    const { card, select, restart, showLogs } = mount();
    byFocus(card, 'api:restart')!.click();
    byFocus(card, 'api:logs')!.click();
    expect(restart).toHaveBeenCalledTimes(1);
    expect(showLogs).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it('the head button selects exactly once; a body click selects', () => {
    const { card, select } = mount();
    const head = byFocus(card, 'api:select')!;
    expect(head.tagName).toBe('BUTTON');
    expect(head.getAttribute('aria-pressed')).toBe('false');
    head.click();
    expect(select).toHaveBeenCalledTimes(1);
    card.querySelector<HTMLElement>('.bf-service-meta')!.click();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('a body click that ends a text selection does not select', () => {
    const { card, select } = mount();
    const meta = card.querySelector<HTMLElement>('.bf-service-meta')!;
    getSelection()!.selectAllChildren(meta);
    meta.click();
    expect(select).not.toHaveBeenCalled();
  });

  it('a card that is not previewable has no switch', () => {
    const card = createServiceCard(db, { labels, previewing: false, restart: vi.fn(), showLogs: vi.fn() });
    expect(byFocus(card, 'db:select')).toBeNull();
    expect(card.hasAttribute('data-previewable')).toBe(false);
  });

  it('the previewed card is marked', () => {
    const card = createServiceCard(web, { labels, previewing: true, select: vi.fn(), restart: vi.fn(), showLogs: vi.fn() });
    expect(card.getAttribute('aria-current')).toBe('true');
    expect(byFocus(card, 'web:select')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('servicesPanel', () => {
  function mount() {
    const actions = { restart: vi.fn(), showLogs: vi.fn(), select: vi.fn() };
    const panel = createServicesPanel(labels, actions);
    document.body.append(panel.root);
    return { panel, actions };
  }
  const note = (root: HTMLElement) => root.querySelector<HTMLElement>('.bf-services-hidden')!;
  const cardIds = (root: HTMLElement) => Array.from(root.querySelectorAll('.bf-service strong')).map((node) => node.textContent);

  it('says Not started before the first render, No services for none, No service is running when all are hidden', () => {
    const { panel } = mount();
    expect(panel.root.querySelector('.bf-empty')!.textContent).toBe(labels.notStarted);
    panel.render([]);
    expect(panel.root.querySelector('.bf-empty')!.textContent).toBe(labels.noServices);
    panel.render([installWeb, installApi]);
    expect(panel.root.querySelector('.bf-empty')!.textContent).toBe(labels.noRunningServices);
  });

  it('Running hides finished one-offs and counts them; All shows them', () => {
    const { panel } = mount();
    panel.render(all, 'web');
    expect(cardIds(panel.root)).toEqual(['db', 'api', 'web']);
    expect(note(panel.root).hidden).toBe(false);
    expect(note(panel.root).textContent).toContain(formatLabel(labels.servicesHidden, { count: 2 }));
    expect(byFocus(panel.root, 'filter:all')!.textContent).toBe(formatLabel(labels.servicesFilterAll, { count: 5 }));
    byFocus(panel.root, 'filter:all')!.click();
    expect(cardIds(panel.root)).toEqual(['db', 'install-web', 'install-api', 'api', 'web']);
    expect(note(panel.root).hidden).toBe(true);
    expect(sessionStorage.getItem(SERVICE_FILTER_STORAGE_KEY)).toBe('all');
  });

  it('remembers the filter for the page session', () => {
    sessionStorage.setItem(SERVICE_FILTER_STORAGE_KEY, 'all');
    const { panel } = mount();
    panel.render(all);
    expect(cardIds(panel.root)).toContain('install-web');
    expect(byFocus(panel.root, 'filter:all')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('puts focus back on the same control after a re-render', () => {
    const { panel } = mount();
    panel.render(all, 'web');
    const before = byFocus(panel.root, 'api:restart')!;
    before.focus();
    panel.render([...all], 'web');
    const after = document.activeElement as HTMLElement;
    expect(after).not.toBe(before);
    expect(after.getAttribute('data-focus')).toBe('api:restart');
  });

  it('"Show all" moves focus to the All filter', () => {
    const { panel } = mount();
    panel.render(all, 'web');
    const showAll = byFocus(panel.root, 'filter:show-all')!;
    showAll.focus();
    showAll.click();
    expect(document.activeElement).toBe(byFocus(panel.root, 'filter:all'));
  });

  it('focus on a card that the filter now hides falls back to the filter that is on', () => {
    const { panel } = mount();
    panel.render(all, 'web');
    byFocus(panel.root, 'api:restart')!.focus();
    panel.render([db, installWeb, installApi, { ...api, state: 'stopped', url: undefined }, web], 'web');
    expect(document.activeElement).toBe(byFocus(panel.root, 'filter:running'));
  });

  it('Restart and Logs reach their actions; the head switches the preview', () => {
    const { panel, actions } = mount();
    panel.render(all, 'web');
    byFocus(panel.root, 'api:restart')!.click();
    byFocus(panel.root, 'api:logs')!.click();
    expect(actions.select).not.toHaveBeenCalled();
    byFocus(panel.root, 'api:select')!.click();
    expect(actions.select).toHaveBeenCalledTimes(1);
    expect(actions.select).toHaveBeenCalledWith('api');
    expect(actions.restart).toHaveBeenCalledWith('api');
    expect(actions.showLogs).toHaveBeenCalledWith('api');
  });
});

describe('launcherView.update', () => {
  function mount() {
    const container = document.createElement('div');
    document.body.append(container);
    const actions = { restart: vi.fn(), showLogs: vi.fn() };
    const view = createLauncherView(container, labels, actions);
    const frame = () => container.querySelector('iframe');
    const heading = () => view.preview.root.querySelector('h2')!.textContent;
    const notice = () => view.preview.root.querySelector('[role="status"]')!.textContent;
    const link = () => view.preview.root.querySelector('a')!;
    return { container, view, actions, frame, heading, notice, link };
  }

  it('shows the frontend by default and leaves the frame alone on repeated updates', () => {
    const { view, frame, heading, link } = mount();
    view.update(all);
    const first = frame()!;
    expect(first.getAttribute('src')).toBe(web.url);
    expect(heading()).toBe(`${labels.preview} · web`);
    view.update(all.map((entry) => ({ ...entry })));
    view.update(all.map((entry) => ({ ...entry, restarts: 1 })));
    expect(frame()).toBe(first);
    expect(first.getAttribute('src')).toBe(web.url);
    expect(link().getAttribute('href')).toBe(previewPageHref(web.url!));
  });

  it('a card click switches the frame, heading and link; a stop goes back to the default with a notice', () => {
    const { container, view, frame, heading, notice, link } = mount();
    view.update(all);
    byFocus(container, 'api:select')!.click();
    expect(frame()!.getAttribute('src')).toBe(api.url);
    expect(heading()).toBe(`${labels.preview} · api`);
    expect(link().getAttribute('href')).toBe(previewPageHref(api.url!));
    expect(byFocus(container, 'api:select')!.getAttribute('aria-pressed')).toBe('true');
    expect(notice()).toBe('');

    view.update([db, installWeb, installApi, { ...api, state: 'stopped', url: undefined }, web]);
    expect(frame()!.getAttribute('src')).toBe(web.url);
    expect(notice()).toBe(formatLabel(labels.previewSelectionLost, { service: 'api' }));
    // Serving again clears the notice; the default stays.
    view.update(all);
    expect(notice()).toBe('');
    expect(heading()).toBe(`${labels.preview} · web`);
  });

  it('regression: Restart on the previewed card keeps it through the stop and comes back to it', () => {
    const { container, view, actions, frame, notice } = mount();
    view.update(all);
    byFocus(container, 'api:select')!.click();
    byFocus(container, 'api:restart')!.click();
    expect(actions.restart).toHaveBeenCalledWith('api');
    for (const state of ['stopping', 'stopped', 'starting'] as const) {
      view.update([db, installWeb, installApi, { ...api, state, url: undefined }, web]);
      expect(frame()!.getAttribute('src')).toBe(web.url);
      expect(notice()).toBe(formatLabel(labels.previewSelectionWaiting, { service: 'api' }));
    }
    view.update(all);
    expect(frame()!.getAttribute('src')).toBe(api.url);
    expect(notice()).toBe('');
  });
});
