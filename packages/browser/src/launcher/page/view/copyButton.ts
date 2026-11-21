/**
 * A button that copies text to the clipboard and says, for a moment, whether it
 * did — on the button and through a polite live region, so a screen reader
 * hears it too. `navigator.clipboard` where the page may use it; otherwise (a
 * non-secure context, a refused permission) an off-screen textarea and
 * `execCommand('copy')`, with focus handed back to wherever it was.
 */
import { el } from './dom.js';

const FEEDBACK_MS = 2_000;

/** Copies `text`; true when the clipboard took it. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (permission, no focus, non-secure context): the textarea route below is the fallback, and its result is what the button reports.
  }
  const previous = document.activeElement as HTMLElement | null;
  // Off-screen, not aria-hidden: it takes focus for the moment of the copy.
  const area = el('textarea', { className: 'bf-offscreen', attrs: { readonly: '', tabindex: '-1' } });
  area.value = text;
  document.body.append(area);
  try {
    area.focus();
    area.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (typeof previous?.focus === 'function') previous.focus();
  }
}

export interface CopyButtonLabels {
  idle: string;
  copied: string;
  failed: string;
}

/** The button and its live region, in one inline wrapper. */
export function createCopyButton(labels: CopyButtonLabels, text: () => string): HTMLSpanElement {
  const button = el('button', { className: 'bf-button bf-button-quiet', attrs: { type: 'button' }, text: labels.idle });
  const status = el('span', { className: 'bf-offscreen', attrs: { role: 'status', 'aria-live': 'polite' } });
  let reset: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    void copyText(text()).then((ok) => {
      const said = ok ? labels.copied : labels.failed;
      button.textContent = said;
      status.textContent = said;
      button.dataset.copy = ok ? 'ok' : 'failed';
      clearTimeout(reset);
      reset = setTimeout(() => {
        button.textContent = labels.idle;
        status.textContent = '';
        delete button.dataset.copy;
      }, FEEDBACK_MS);
    });
  });
  return el('span', { className: 'bf-copy' }, [button, status]);
}
