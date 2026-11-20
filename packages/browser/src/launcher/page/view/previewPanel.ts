/** The preview: the primary frontend service in a frame, with a link that opens it in its own tab. */
import type { LauncherLabels } from '../../labels.js';
import { el, replaceChildren } from './dom.js';

export function createPreviewPanel(labels: LauncherLabels) {
  const body = el('div', { className: 'bf-preview-body' }, [el('p', { className: 'bf-empty', text: labels.noPreview })]);
  const link = el('a', { className: 'bf-link', attrs: { target: '_blank', rel: 'noopener noreferrer', hidden: '' }, text: labels.openInNewTab });
  const title = el('h2', { text: labels.preview });
  const root = el('section', { className: 'bf-panel bf-preview', attrs: { 'aria-label': labels.preview } }, [el('div', { className: 'bf-panel-head' }, [title, link]), body]);
  let shown: string | undefined;

  return {
    root,
    /** Show `url` (the service `serviceId` serves); undefined clears the frame. */
    show(url: string | undefined, serviceId?: string): void {
      if (url === shown) return;
      shown = url;
      if (!url) {
        link.hidden = true;
        title.textContent = labels.preview;
        replaceChildren(body, [el('p', { className: 'bf-empty', text: labels.noPreview })]);
        return;
      }
      link.href = url;
      link.hidden = false;
      title.textContent = serviceId ? `${labels.preview} · ${serviceId}` : labels.preview;
      replaceChildren(body, [el('iframe', { className: 'bf-frame', attrs: { src: url, title: serviceId ?? labels.preview } })]);
    },
  };
}

export type PreviewPanel = ReturnType<typeof createPreviewPanel>;
