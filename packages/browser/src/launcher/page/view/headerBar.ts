/** The page header: the application's name, its environment and target, a tier badge, and the launch status. */
import { formatLabel, type LauncherLabels } from '../../labels.js';
import type { LaunchHeader } from '../launchPlan.js';
import { el, replaceChildren } from './dom.js';

export type LaunchStatusTone = 'busy' | 'ok' | 'error';

export function createHeaderBar(labels: LauncherLabels) {
  const title = el('h1', { className: 'bf-title', text: labels.title });
  const meta = el('div', { className: 'bf-meta' });
  const status = el('p', { className: 'bf-status', attrs: { role: 'status', 'aria-live': 'polite' }, text: labels.loading });
  const root = el('header', { className: 'bf-header' }, [el('div', { className: 'bf-header-main' }, [title, meta]), status]);
  const setStatus = (text: string, tone: LaunchStatusTone = 'busy') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  return {
    root,
    setHeader(header: LaunchHeader): void {
      title.textContent = header.name;
      document.title = `${header.name} · ${labels.title}`;
      const tier =
        header.tier === 'production' ? labels.tierProduction : header.tier === 'non-production' ? labels.tierNonProduction : null;
      replaceChildren(meta, [
        header.environment && el('span', { className: 'bf-chip', text: `${labels.environment}: ${header.environment}` }),
        header.target && el('span', { className: 'bf-chip', text: `${labels.target}: ${header.target}` }),
        tier && el('span', { className: `bf-badge bf-badge-${header.tier}`, text: tier }),
      ]);
    },
    setStatus,
    setError(message: string): void {
      setStatus(formatLabel(labels.startFailed, { message }), 'error');
    },
  };
}

export type HeaderBar = ReturnType<typeof createHeaderBar>;
