/**
 * The preview: one service in a frame (the default frontend, or the service chosen on
 * its card), with a link that opens it in its own tab — through this origin's `/preview`
 * page, which frames it there: a top-level tab on the preview origin itself has no
 * service worker (another storage partition), so it could not load. A polite live
 * region says when a chosen service stopped and the preview went back to the default.
 */
import type { LauncherLabels } from '../../labels.js';
import { previewPageHref } from '../../protocol.js';
import { el, replaceChildren } from './dom.js';

export function createPreviewPanel(labels: LauncherLabels) {
  const body = el('div', { className: 'bf-preview-body' }, [el('p', { className: 'bf-empty', text: labels.noPreview })]);
  const link = el('a', { className: 'bf-link', attrs: { target: '_blank', rel: 'noopener noreferrer', hidden: '' }, text: labels.openInNewTab });
  const title = el('h2', { text: labels.preview });
  const notice = el('p', { className: 'bf-note', attrs: { role: 'status', 'aria-live': 'polite' } });
  const root = el('section', { className: 'bf-panel bf-preview', attrs: { 'aria-label': labels.preview } }, [el('div', { className: 'bf-panel-head' }, [title, link]), notice, body]);
  let shown: string | undefined;

  return {
    root,
    /** Show `url` (the service `serviceId` serves); undefined clears the frame. `note` (or none) is the live notice beside it. */
    show(url: string | undefined, serviceId?: string, note?: string): void {
      if (notice.textContent !== (note ?? '')) notice.textContent = note ?? '';
      if (url === shown) return;
      shown = url;
      if (!url) {
        link.hidden = true;
        title.textContent = labels.preview;
        replaceChildren(body, [el('p', { className: 'bf-empty', text: labels.noPreview })]);
        return;
      }
      link.href = previewPageHref(url);
      link.hidden = false;
      title.textContent = serviceId ? `${labels.preview} · ${serviceId}` : labels.preview;
      replaceChildren(body, [el('iframe', { className: 'bf-frame', attrs: { src: url, title: serviceId ?? labels.preview } })]);
    },
  };
}

export type PreviewPanel = ReturnType<typeof createPreviewPanel>;
