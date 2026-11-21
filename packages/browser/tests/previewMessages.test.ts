import { describe, expect, it } from 'vitest';
import { CONSOLE_MESSAGE_TYPE, CSP_VIOLATION_LIMIT, CSP_VIOLATION_MESSAGE_TYPE, ERROR_MESSAGE_TYPE, PREVIEW_TIMING_FEATURES, TIMING_MESSAGE_TYPE } from '@seanhogg/builderforce-webcontainers-core';
import { CSP_VIOLATION_RUNTIME_LIMIT, listenToPreview, type PreviewConsoleMessage, type PreviewCspViolation, type PreviewError, type PreviewTiming } from '../src/previewMessages.js';

function fakeWindow() {
  let handler: ((event: MessageEvent) => void) | undefined;
  return {
    addEventListener: (_type: string, listener: EventListener) => void (handler = listener as (event: MessageEvent) => void),
    removeEventListener: () => void (handler = undefined),
    post: (origin: string, data: unknown) => handler?.({ origin, data } as MessageEvent),
    get attached() {
      return handler !== undefined;
    },
  };
}

describe('listenToPreview', () => {
  it('delivers errors and console output from this runtime only', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    const errors: PreviewError[] = [];
    const logs: PreviewConsoleMessage[] = [];
    messages.onError((e) => errors.push(e));
    messages.onConsole((m) => logs.push(m));

    const href = 'https://preview.test/__bfwc/p1/index.html';
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'warn', text: 'careful', href });
    win.post('https://preview.test', { type: ERROR_MESSAGE_TYPE, message: 'boom', stack: 'at x', href });
    win.post('https://evil.test', { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'spoof', href });
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'other runtime', href: 'https://preview.test/__bfwc/p2/' });
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'trace', text: 'unknown level', href });

    expect(logs).toEqual([{ level: 'warn', text: 'careful', href }]);
    expect(errors).toEqual([{ message: 'boom', stack: 'at x', href, source: 'error' }]); // no source (an older bridge) reads as 'error'
    messages.dispose();
    expect(win.attached).toBe(false);
  });

  it('requires the runtime nonce when it has one, so another frame cannot claim this base by href', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/', 'n0nce');
    const logs: PreviewConsoleMessage[] = [];
    messages.onConsole((m) => logs.push(m));
    const href = 'https://preview.test/__bfwc/p1/index.html';
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'no nonce', href });
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'wrong nonce', href, nonce: 'other' });
    win.post('https://preview.test', { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'mine', href, nonce: 'n0nce' });
    expect(logs).toEqual([{ level: 'log', text: 'mine', href }]);
    messages.dispose();
  });

  it("refuses a page on one application's origin claiming another application's address", () => {
    const win = fakeWindow();
    const A = 'https://a.preview.test';
    const B = 'https://b.preview.test';
    const messages = listenToPreview(win, (origin) => origin === A || origin === B, '/__bfwc/p1/');
    const logs: PreviewConsoleMessage[] = [];
    const errors: PreviewError[] = [];
    messages.onConsole((m) => logs.push(m));
    messages.onError((e) => errors.push(e));
    win.post(A, { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'spoof', href: `${B}/__bfwc/p1/` });
    win.post(A, { type: ERROR_MESSAGE_TYPE, message: 'spoof', href: `${B}/__bfwc/p1/` });
    win.post(B, { type: CONSOLE_MESSAGE_TYPE, level: 'log', text: 'real', href: `${B}/__bfwc/p1/` });
    expect(logs).toEqual([{ level: 'log', text: 'real', href: `${B}/__bfwc/p1/` }]);
    expect(errors).toEqual([]);
    messages.dispose();
  });

  it('carries the error source, and reads an unknown one as an uncaught error', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    const errors: PreviewError[] = [];
    messages.onError((e) => errors.push(e));
    const href = 'https://preview.test/__bfwc/p1/index.html';
    win.post('https://preview.test', { type: ERROR_MESSAGE_TYPE, source: 'rejection', message: 'nope', href });
    win.post('https://preview.test', { type: ERROR_MESSAGE_TYPE, source: 'bogus', message: 'odd', href });
    expect(errors.map((e) => e.source)).toEqual(['rejection', 'error']);
    messages.dispose();
  });

  it('reports a failing Angular bootstrap (console.error of an Error) with its NG code', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/', 'n0nce');
    const errors: PreviewError[] = [];
    messages.onError((e) => errors.push(e));
    const href = 'https://preview.test/__bfwc/p1/index.html';
    const line = 'NG0202: No provider for _HttpClient! (_AppComponent -> _HttpClient)';
    // What the bridge posts for `bootstrapApplication(App).catch((err) => console.error(err))`.
    win.post('https://preview.test', {
      type: ERROR_MESSAGE_TYPE,
      source: 'console',
      message: `\u001b[31m${line}\u001b[39m`,
      stack: `RuntimeError: ${line}\n    at bootstrap (main.js:3:9)`,
      href,
      nonce: 'n0nce',
    });
    expect(errors).toEqual([{ source: 'console', code: 'NG0202', message: line, stack: `RuntimeError: ${line}\n    at bootstrap (main.js:3:9)`, href }]);
    messages.dispose();
  });
});

describe('CSP violations, bounded host-side (the page that posts them runs the app)', () => {
  const violation = (href: string, blockedOrigin: string, directive = 'img-src') => ({ type: CSP_VIOLATION_MESSAGE_TYPE, directive, blockedOrigin, disposition: 'enforce', href });

  it('passes each (page, directive, origin) once — a query or hash is the same page — and at most the per-page limit', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    const seen: PreviewCspViolation[] = [];
    messages.onCspViolation((v) => seen.push(v));
    const page = 'https://preview.test/__bfwc/p1/index.html';
    win.post('https://preview.test', violation(page, 'https://a.example'));
    win.post('https://preview.test', violation(`${page}?reload=1#x`, 'https://a.example')); // the same page re-posting
    win.post('https://preview.test', violation(page, 'https://a.example', 'connect-src')); // another directive
    win.post('https://preview.test', violation('https://preview.test/__bfwc/p1/other.html', 'https://a.example')); // another page
    expect(seen).toHaveLength(3);
    // A flood of distinct origins from one page: the host stops at the page's limit, whatever the page posts.
    for (let i = 0; i < CSP_VIOLATION_LIMIT * 4; i++) win.post('https://preview.test', violation(`${page}?n=${i}`, `https://h${i}.example`));
    expect(seen).toHaveLength(CSP_VIOLATION_LIMIT + 1); // the page's first two, its flood to the limit, the other page's one
    messages.dispose();
  });

  it('a timing entry saying a measurement was unavailable passes only with a known feature name', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    const seen: PreviewTiming[] = [];
    messages.onTiming((t) => seen.push(t));
    win.post('https://preview.test', {
      type: TIMING_MESSAGE_TYPE,
      href: 'https://preview.test/__bfwc/p1/',
      entries: [
        { kind: 'unavailable', feature: PREVIEW_TIMING_FEATURES.paint },
        { kind: 'unavailable', feature: 'anything-the-app-likes' },
        { kind: 'unavailable' },
      ],
    });
    expect(seen).toEqual([{ kind: 'unavailable', feature: 'paintTiming' }]);
    messages.dispose();
  });

  it('stops at the runtime-wide limit however many pages a preview invents', () => {
    const win = fakeWindow();
    const messages = listenToPreview(win, 'https://preview.test', '/__bfwc/p1/');
    let delivered = 0;
    messages.onCspViolation(() => delivered++);
    for (let p = 0; p < 50; p++) {
      for (let i = 0; i < CSP_VIOLATION_LIMIT; i++) win.post('https://preview.test', violation(`https://preview.test/__bfwc/p1/page${p}.html`, `https://h${i}.example`));
    }
    expect(delivered).toBe(CSP_VIOLATION_RUNTIME_LIMIT);
    messages.dispose();
  });
});
