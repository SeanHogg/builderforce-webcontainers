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
    expect(errors).toEqual([{ message: 'boom', stack: 'at x', href }]);
    messages.dispose();
    expect(win.attached).toBe(false);
  });
});
