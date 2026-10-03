/**
 * `readline` and `readline/promises`: line splitting over any input stream,
 * `question`, prompts and async iteration — what interactive CLIs (create-*,
 * inquirer's simple paths, REPL-ish scripts) use. Input arrives already
 * line-edited by the terminal's line discipline, so no keypress decoding is
 * needed beyond `emitKeypressEvents` delivering characters.
 */
import { EventEmitterBase } from './events.js';

interface Input extends EventEmitterBase {
  resume?(): unknown;
  pause?(): unknown;
  setEncoding?(e: string): unknown;
}
interface Output {
  write(chunk: string): unknown;
}

class Interface extends EventEmitterBase {
  line = '';
  cursor = 0;
  terminal: boolean;
  closed = false;
  private buffer = '';
  private promptText = '> ';
  private pendingQuestion?: (answer: string) => void;
  private readonly onData = (chunk: unknown) => this.feed(String(chunk));
  private readonly onEnd = () => {
    if (this.buffer) this.emitLine(this.buffer);
    this.buffer = '';
    this.close();
  };

  constructor(readonly input: Input, readonly output?: Output, options: { prompt?: string; terminal?: boolean } = {}) {
    super();
    this.terminal = options.terminal ?? !!(output as { isTTY?: boolean } | undefined)?.isTTY;
    if (options.prompt !== undefined) this.promptText = options.prompt;
    input.setEncoding?.('utf8');
    input.on('data', this.onData);
    input.on('end', this.onEnd);
    input.resume?.();
  }

  setPrompt(prompt: string): void {
    this.promptText = prompt;
  }
  getPrompt(): string {
    return this.promptText;
  }
  prompt(): void {
    this.output?.write(this.promptText);
  }
  question(query: string, options: unknown, callback?: (answer: string) => void): void {
    const cb = (typeof options === 'function' ? options : callback) as (answer: string) => void;
    this.output?.write(query);
    this.pendingQuestion = cb;
  }
  write(data: string): void {
    this.feed(data);
  }
  pause(): this {
    this.input.pause?.();
    this.emit('pause');
    return this;
  }
  resume(): this {
    this.input.resume?.();
    this.emit('resume');
    return this;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.removeListener('data', this.onData);
    this.input.removeListener('end', this.onEnd);
    this.input.pause?.();
    this.emit('close');
  }
  getCursorPos(): { rows: number; cols: number } {
    return { rows: 0, cols: this.cursor };
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    this.on('line', (line: string) => {
      queue.push(line);
      wake?.();
    });
    this.on('close', () => wake?.());
    while (true) {
      if (queue.length) yield queue.shift()!;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }

  private feed(text: string): void {
    this.buffer += text;
    for (;;) {
      const nl = this.buffer.search(/\r\n|\n|\r/);
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(this.buffer[nl] === '\r' && this.buffer[nl + 1] === '\n' ? nl + 2 : nl + 1);
      this.emitLine(line);
    }
    this.line = this.buffer;
    this.cursor = this.buffer.length;
  }

  private emitLine(line: string): void {
    const question = this.pendingQuestion;
    if (question) {
      this.pendingQuestion = undefined;
      question(line);
    } else this.emit('line', line);
  }
}

const ansi = (stream: Output | undefined, sequence: string, cb?: () => void) => {
  stream?.write(sequence);
  cb?.();
  return true;
};

export function createReadlineModule(promises = false): Record<string, unknown> {
  const createInterface = (input: Input | { input: Input; output?: Output; prompt?: string; terminal?: boolean }, output?: Output) => {
    const opts = 'input' in input && (input as { input?: unknown }).input ? (input as { input: Input; output?: Output; prompt?: string; terminal?: boolean }) : { input: input as Input, output };
    const rl = new Interface(opts.input, opts.output, opts);
    if (promises) {
      const ask = rl.question.bind(rl);
      (rl as unknown as { question: (q: string) => Promise<string> }).question = (query: string) => new Promise((resolve) => ask(query, undefined, resolve));
    }
    return rl;
  };
  const mod: Record<string, unknown> = {
    createInterface,
    Interface,
    clearLine: (stream: Output, dir: number, cb?: () => void) => ansi(stream, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K', cb),
    clearScreenDown: (stream: Output, cb?: () => void) => ansi(stream, '\x1b[0J', cb),
    cursorTo: (stream: Output, x: number, y?: number | (() => void), cb?: () => void) => ansi(stream, typeof y === 'number' ? `\x1b[${y + 1};${x + 1}H` : `\x1b[${x + 1}G`, typeof y === 'function' ? y : cb),
    moveCursor: (stream: Output, dx: number, dy: number, cb?: () => void) =>
      ansi(stream, (dx < 0 ? `\x1b[${-dx}D` : dx > 0 ? `\x1b[${dx}C` : '') + (dy < 0 ? `\x1b[${-dy}A` : dy > 0 ? `\x1b[${dy}B` : ''), cb),
    emitKeypressEvents(stream: EventEmitterBase) {
      if ((stream as { __keypress?: boolean }).__keypress) return;
      (stream as { __keypress?: boolean }).__keypress = true;
      stream.on('data', (chunk: unknown) => {
        for (const ch of String(chunk)) {
          const name = ch === '\r' || ch === '\n' ? 'return' : ch === '\x7f' ? 'backspace' : ch === '\x03' ? 'c' : /[a-z]/i.test(ch) ? ch.toLowerCase() : undefined;
          stream.emit('keypress', ch, { sequence: ch, name, ctrl: ch === '\x03', meta: false, shift: /[A-Z]/.test(ch) });
        }
      });
    },
  };
  if (!promises) mod.promises = createReadlineModule(true);
  return mod;
}
