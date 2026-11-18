import { describe, expect, it } from 'vitest';
import { CONSOLE_MESSAGE_TYPE, ERROR_MESSAGE_TYPE } from '@seanhogg/builderforce-webcontainers-core';
import { listenToPreview, type PreviewConsoleMessage, type PreviewError } from '../src/previewMessages.js';

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
