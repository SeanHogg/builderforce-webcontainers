/**
 * `copyText`'s clipboard and fallback routes. The browser package's tests run
 * in Node with no DOM environment (no jsdom/happy-dom here), so `navigator` and
 * `document` are small stubs holding exactly what `copyText` touches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../../src/launcher/page/view/copyButton.js';

interface FakeElement {
  tag: string;
  className: string;
  attrs: Record<string, string>;
  value: string;
  removed: boolean;
  setAttribute(name: string, value: string): void;
  append(): void;
  focus(): void;
  select(): void;
  remove(): void;
}

function fakeDocument(copyResult: boolean | 'throw') {
  const doc = {
    activeElement: null as FakeElement | null,
    created: [] as FakeElement[],
    copied: [] as string[],
    body: { append: vi.fn() },
    createElement(tag: string): FakeElement {
      const element: FakeElement = {
        tag,
        className: '',
        attrs: {},
        value: '',
        removed: false,
        setAttribute: (name, value) => void (element.attrs[name] = value),
        append: () => undefined,
        focus: () => void (doc.activeElement = element),
        select: () => undefined,
        remove: () => void (element.removed = true),
      };
      doc.created.push(element);
      return element;
    },
    execCommand(command: string): boolean {
      if (copyResult === 'throw') throw new Error('not allowed');
      if (command === 'copy') doc.copied.push((doc.activeElement as FakeElement).value);
      return copyResult;
    },
  };
  return doc;
}

afterEach(() => vi.unstubAllGlobals());

describe('copyText', () => {
  it('uses navigator.clipboard when the page may', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', fakeDocument(true));
    expect(await copyText('report')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('report');
  });

  it('regression: falls back to an off-screen, focusable textarea and hands focus back', async () => {
    const doc = fakeDocument(true);
    const button = doc.createElement('button');
    button.focus();
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) } });
    vi.stubGlobal('document', doc);
    expect(await copyText('report')).toBe(true);
    const area = doc.created.find((element) => element.tag === 'textarea')!;
    expect(doc.copied).toEqual(['report']);
    expect(area.className).toBe('bf-offscreen');
    expect(area.attrs['aria-hidden']).toBeUndefined();
    expect(area.removed).toBe(true);
    expect(doc.activeElement).toBe(button);
  });

  it('reports a failed fallback, with no clipboard API at all, and still restores focus', async () => {
    for (const result of [false, 'throw'] as const) {
      const doc = fakeDocument(result);
      const button = doc.createElement('button');
      button.focus();
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('document', doc);
      expect(await copyText('report')).toBe(false);
      expect(doc.activeElement).toBe(button);
    }
  });
});
