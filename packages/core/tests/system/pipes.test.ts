import { describe, expect, it } from 'vitest';
import { InputQueue } from '../../src/system/terminal.js';
import { BrokenPipeError, SIGPIPE_STATUS, brokePipe, isBrokenPipe } from '../../src/system/signals.js';
import { pushStream } from '../../src/system/httpStream.js';

describe('InputQueue as a pipe', () => {
  it('fails writes with EPIPE once the reader has closed, dropping what it never read', async () => {
    const pipe = new InputQueue();
    pipe.push('unread');
    pipe.closeReader();
    expect(pipe.isReaderClosed).toBe(true);
    expect(() => pipe.push('more')).toThrow(BrokenPipeError);
    let caught: unknown;
    try {
      pipe.push('again');
    } catch (error) {
      caught = error;
    }
    expect(isBrokenPipe(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('EPIPE');
    // The error names the pipe that broke, so only the stage writing into it absorbs it.
    expect(brokePipe(caught, pipe)).toBe(true);
    expect(brokePipe(caught, new InputQueue())).toBe(false);
    expect(() => pipe.push(null)).not.toThrow(); // closing the write end is always fine
    expect(SIGPIPE_STATUS).toBe(141);
  });

  it('readLines takes the first lines across chunks and stops reading', async () => {
    const pipe = new InputQueue();
    pipe.push('a\nb');
    pipe.push('\nc\nd\n');
    expect(await pipe.readLines(2)).toBe('a\nb\n');
    const short = new InputQueue();
    short.push('only');
    short.push(null);
    expect(await short.readLines(3)).toBe('only');
    expect(await new InputQueue().readLines(0)).toBe('');
  });
});

describe('pushStream backpressure', () => {
  it('reports full at the high-water mark and is ready again once the reader pulls', async () => {
    const body = pushStream(undefined, 4);
    expect(body.push(new Uint8Array(2))).toBe(true);
    expect(body.push(new Uint8Array(2))).toBe(false);
    let ready = false;
    const waiting = body.ready().then(() => (ready = true));
    await Promise.resolve();
    expect(ready).toBe(false);
    const reader = body.stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(2);
    await waiting;
    expect(ready).toBe(true);
    body.end();
  });

  it('wakes a waiting producer when the reader hangs up, and calls onCancel', async () => {
    const reasons: unknown[] = [];
    const body = pushStream((reason) => reasons.push(reason), 1);
    expect(body.push(new Uint8Array(1))).toBe(false);
    const waiting = body.ready();
    await body.stream.cancel('gone');
    await waiting;
    expect(reasons).toEqual(['gone']);
    expect(body.done).toBe(true);
    expect(body.push(new Uint8Array(1))).toBe(false);
  });
});
