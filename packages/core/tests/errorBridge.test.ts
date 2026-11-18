import { describe, expect, it } from 'vitest';
import { CONSOLE_MESSAGE_TYPE, ERROR_MESSAGE_LIMIT, ERROR_MESSAGE_TYPE, errorBridgeScript } from '../src/html.js';
import { previewErrorText } from '../src/previewErrorText.js';

interface Posted {
  type: string;
  [key: string]: unknown;
}

/** Runs the bridge against a stubbed window: a parent that records messages, a console that records calls. */
function runBridge(nonce = 'n0nce') {
  const posted: Posted[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const logged: unknown[][] = [];
  const record = (...args: unknown[]) => void logged.push(args);
  const fakeConsole: Record<string, unknown> = { log: record, info: record, warn: record, error: record, debug: record };
  const fakeWindow: Record<string, unknown> = {};
  const body = errorBridgeScript(nonce).replace(/^<script>/, '').replace(/<\/script>$/, '');
  new Function('window', 'parent', 'location', 'addEventListener', 'console', body)(
    fakeWindow,
    { postMessage: (message: Posted) => posted.push(message) },
    { href: 'https://preview.test/__bfwc/p1/' },
    (type: string, listener: (event: unknown) => void) => (listeners[type] = listener),
    fakeConsole,
  );
  return { posted, listeners, logged, console: fakeConsole as Record<'log' | 'error', (...args: unknown[]) => void>, on: (type: string, event: unknown) => listeners[type]!(event) };
}

const errorsOf = (posted: Posted[]) => posted.filter((m) => m.type === ERROR_MESSAGE_TYPE);
const consolesOf = (posted: Posted[]) => posted.filter((m) => m.type === CONSOLE_MESSAGE_TYPE);

describe('errorBridgeScript', () => {
  it('tags uncaught errors and rejections with their source', () => {
    const { posted, on } = runBridge();
    const thrown = new Error('boom');
    on('error', { message: 'Uncaught Error: boom', error: thrown });
    on('unhandledrejection', { reason: new Error('nope') });
    expect(errorsOf(posted)).toMatchObject([
      { source: 'error', message: 'Uncaught Error: boom', stack: thrown.stack, nonce: 'n0nce', href: 'https://preview.test/__bfwc/p1/' },
      { source: 'rejection', message: 'nope' },
    ]);
  });

  it('posts console.error with an Error object as console output AND an error (a failed bootstrap)', () => {
    const { posted, console, logged } = runBridge();
    const failure = new Error("NG0202: No provider for _HttpClient! (_AppComponent -> _HttpClient)");
    console.error('ERROR', failure);
    expect(consolesOf(posted)).toHaveLength(1);
    expect(consolesOf(posted)[0]).toMatchObject({ level: 'error' });
    expect(errorsOf(posted)).toEqual([
      expect.objectContaining({ source: 'console', message: failure.message, stack: failure.stack, nonce: 'n0nce' }),
    ]);
    expect(logged).toEqual([['ERROR', failure]]); // the real console still gets the call
  });

  it('keeps plain-string console.error (React dev warnings) as console output only', () => {
    const { posted, console } = runBridge();
    console.error('Warning: Each child in a list should have a unique "key" prop.');
    console.log(new Error('logged, not raised'));
    expect(consolesOf(posted)).toHaveLength(2);
    expect(errorsOf(posted)).toEqual([]);
  });

  it(`caps errors at ${ERROR_MESSAGE_LIMIT} per page load, apart from the console cap`, () => {
    const { posted, console, on } = runBridge();
    for (let i = 0; i < ERROR_MESSAGE_LIMIT + 20; i++) console.error(new Error(`loop ${i}`));
    on('error', { message: 'after the cap', error: new Error('after the cap') });
    expect(errorsOf(posted)).toHaveLength(ERROR_MESSAGE_LIMIT);
    expect(consolesOf(posted)).toHaveLength(ERROR_MESSAGE_LIMIT + 20); // still under its own 1,000 cap
  });
});

describe('previewErrorText', () => {
  it("extracts Angular's NG0303 from a template binding error", () => {
    const message = "NG0303: Can't bind to 'foo' since it isn't a known property of 'div' (used in the '_AppComponent' component template).";
    expect(previewErrorText(message, `Error: ${message}\n    at x (main.js:1:1)`)).toEqual({ message, code: 'NG0303' });
  });

  it('strips Error:/RuntimeError:/ERROR prefixes and finds the code in the stack', () => {
    const line = 'NG0202: No provider for _HttpClient! (_AppComponent -> _HttpClient)';
    expect(previewErrorText('ERROR RuntimeError: ' + line)).toEqual({ message: line, code: 'NG0202' });
    expect(previewErrorText('Something failed', `RuntimeError: ${line}\n    at r3 (core.mjs:1:1)`)).toEqual({ message: line, code: 'NG0202' });
  });

  it('takes the first line naming the code (NG0908 with a docs link after it)', () => {
    const message = 'Error: NG0908: In this configuration Angular requires Zone.js\nFind more at https://angular.dev/errors/NG0908';
    expect(previewErrorText(message)).toEqual({ message: 'NG0908: In this configuration Angular requires Zone.js', code: 'NG0908' });
  });

  it('leaves a non-Angular message as it is, minus ANSI escapes', () => {
    expect(previewErrorText("Cannot read properties of undefined (reading 'x')", 'TypeError: …')).toEqual({ message: "Cannot read properties of undefined (reading 'x')" });
    expect(previewErrorText('\u001b[31mred failure\u001b[39m')).toEqual({ message: 'red failure' });
  });
});
