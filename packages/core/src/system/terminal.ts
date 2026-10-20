/**
 * What a kernel's TTY layer does between xterm.js and a program:
 *
 * - InputQueue: stdin as a buffered stream of chunks — text, or bytes (data that arrives
 *   before the program subscribes is kept, not dropped). As a pipe, its reader
 *   closes it on exit (`closeReader`): what was buffered is dropped and later
 *   writes throw EPIPE, so the writer stops instead of buffering forever.
 * - LineDiscipline: "cooked" mode — echo, backspace, Ctrl-U, Enter delivers the
 *   line, Ctrl-C raises SIGINT, Ctrl-D is end-of-file. A program that calls
 *   `setRawMode(true)` (the shell, prompts libraries) gets keystrokes untouched.
 * - toTerminal: `\n` → `\r\n` on output (the TTY's ONLCR), since xterm.js
 *   only moves to column 0 on `\r`.
 */
import type { StdioChunk } from './types.js';
import { BrokenPipeError } from './signals.js';


export class InputQueue<T extends StdioChunk = string> {
  private readonly buffered: Array<T | null> = [];
  private readonly listeners = new Set<(chunk: T | null) => void>();
  private ended = false;

  private draining = false;
  private readerClosed = false;

  /** Queue a chunk (`null`: end-of-file). Throws {@link BrokenPipeError} once the reader has closed; ending is always allowed. */
  push(chunk: T | null): void {
    if (this.readerClosed) {
      if (chunk === null) return;
      throw new BrokenPipeError(this);
    }
    if (this.ended) return;
    if (chunk === null) this.ended = true;
    this.buffered.push(chunk);
    this.drain();
  }

  subscribe(listener: (chunk: T | null) => void): () => void {
    this.listeners.add(listener);
    this.drain();
    return () => this.listeners.delete(listener);
  }

  /**
   * Deliver on a microtask: a subscriber has always stored its unsubscribe
   * function by then, and chunks stay buffered until someone is actually
   * listening — one that leaves early does not take data with it.
   */
  private drain(): void {
    if (this.draining || !this.listeners.size || !this.buffered.length) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      while (this.buffered.length && this.listeners.size) {
        const chunk = this.buffered.shift()!;
        for (const listener of [...this.listeners]) listener(chunk);
      }
    });
  }

  /** Everything until end-of-file. */
  readAll(): Promise<string> {
    return new Promise((resolve) => {
      let text = '';
      const stop = this.subscribe(
        textChunks((chunk) => {
          if (chunk === null) {
            stop();
            resolve(text);
          } else text += chunk;
        }),
      );
    });
  }

  /**
   * The first `count` lines (each with its `\n`; fewer at end-of-file), then stop
   * reading — what `head` needs to exit early, so the writer upstream gets EPIPE.
   */
  readLines(count: number): Promise<string> {
    return new Promise((resolve) => {
      if (count <= 0) return resolve('');
      let text = '';
      let found = 0;
      let done = false;
      const finish = () => {
        done = true;
        stop();
        resolve(text);
      };
      const stop = this.subscribe(
        textChunks((chunk) => {
          if (done) return;
          if (chunk === null) return finish();
          for (let from = 0; ; ) {
            const newline = chunk.indexOf('\n', from);
            if (newline < 0) return void (text += chunk.slice(from));
            text += chunk.slice(from, newline + 1);
            from = newline + 1;
            if (++found === count) return finish();
          }
        }),
      );
    });
  }

  /** The reader is gone (a pipeline stage exited): drop what it never read; later writes fail with EPIPE. */
  closeReader(): void {
    this.readerClosed = true;
    this.buffered.length = 0;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get isReaderClosed(): boolean {
    return this.readerClosed;
  }
}

/**
 * A text listener over a bytes-or-text stream: bytes are decoded as UTF-8 with
 * characters split across chunks kept whole; `null` (end) flushes, then passes on.
 */
export function textChunks(listener: (text: string | null) => void): (chunk: StdioChunk | null) => void {
  const decoder = new TextDecoder();
  return (chunk) => {
    if (chunk === null) {
      const rest = decoder.decode();
      if (rest) listener(rest);
      listener(null);
      return;
    }
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (text) listener(text);
  };
}

export function toTerminal(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}

export interface LineDisciplineOptions {
  /** Echo to the terminal. */
  echo(text: string): void;
  /** A completed line (with its `\n`), or `null` for end-of-file. */
  deliver(chunk: string | null): void;
  /** Ctrl-C / Ctrl-\. */
  signal(name: 'SIGINT' | 'SIGQUIT'): void;
}

export class LineDiscipline {
  raw = false;
  private line = '';

  constructor(private readonly options: LineDisciplineOptions) {}

  input(data: string): void {
    if (this.raw) {
      this.options.deliver(data);
      return;
    }
    // Arrow keys and other escape sequences have no meaning in cooked mode.
    const text = data.replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]/g, '');
    for (const ch of text) {
      switch (ch) {
        case '\r':
        case '\n':
          this.options.echo('\r\n');
          this.options.deliver(this.line + '\n');
          this.line = '';
          break;
        case '\x7f':
        case '\b':
          if (this.line) {
            this.line = [...this.line].slice(0, -1).join('');
            this.options.echo('\b \b');
          }
          break;
        case '\x03':
          this.options.echo('^C\r\n');
          this.line = '';
          this.options.signal('SIGINT');
          break;
        case '\x1c':
          this.options.signal('SIGQUIT');
          break;
        case '\x04':
          if (this.line) {
            this.options.deliver(this.line);
            this.line = '';
          } else this.options.deliver(null);
          break;
        case '\x15':
          this.options.echo('\b \b'.repeat([...this.line].length));
          this.line = '';
          break;
        default:
          if (ch >= ' ' || ch === '\t') {
            this.line += ch;
            this.options.echo(ch);
          }
      }
    }
  }
}
