/**
 * Readline-style line editing for an xterm.js terminal in raw mode: insert and
 * delete at the cursor, ←/→, Home/End (and Ctrl-A/E), ↑/↓ history, Ctrl-U/K/W,
 * Ctrl-L, Tab completion, Ctrl-C (cancel the line) and Ctrl-D (end of input).
 *
 * `feed` consumes input up to the first completed line and hands back the rest,
 * so a pasted block of several commands runs them one at a time.
 */

export type EditorEvent = { type: 'line'; line: string } | { type: 'interrupt' } | { type: 'eof' };

export interface LineEditorOptions {
  write(text: string): void;
  history: string[];
  /** Candidates for the word ending at the cursor (`word` is that word). */
  complete?(line: string, word: string): string[];
}

const KEYS: Array<[RegExp, string]> = [
  [/^\x1b\[(?:1;\d)?A/, 'up'],
  [/^\x1b\[(?:1;\d)?B/, 'down'],
  [/^\x1b\[1;[35]C|^\x1bf/, 'wordRight'],
  [/^\x1b\[1;[35]D|^\x1bb/, 'wordLeft'],
  [/^\x1b\[C|^\x1bOC/, 'right'],
  [/^\x1b\[D|^\x1bOD/, 'left'],
  [/^\x1b\[(?:H|1~|7~)|^\x1bOH/, 'home'],
  [/^\x1b\[(?:F|4~|8~)|^\x1bOF/, 'end'],
  [/^\x1b\[3~/, 'delete'],
  [/^\x1b\[[0-9;]*[~A-Za-z]|^\x1bO[A-Za-z]|^\x1b./, 'ignore'],
];

function commonPrefix(words: string[]): string {
  if (!words.length) return '';
  let prefix = words[0]!;
  for (const w of words) while (!w.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

export class LineEditor {
  line = '';
  cursor = 0;
  prompt = '';
  private historyIndex = -1;
  private draft = '';

  constructor(private readonly options: LineEditorOptions) {}

  /** Show `prompt` and start a fresh line. */
  begin(prompt: string): void {
    this.prompt = prompt;
    this.line = '';
    this.cursor = 0;
    this.historyIndex = -1;
    this.options.write(prompt);
  }

  feed(data: string): { event?: EditorEvent; rest: string } {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === '\x1b') {
        const slice = data.slice(i);
        const key = KEYS.find(([re]) => re.test(slice));
        const match = key ? key[0].exec(slice)![0] : '\x1b';
        i += match.length;
        this.key(key?.[1] ?? 'ignore');
        continue;
      }
      i++;
      switch (ch) {
        case '\r':
        case '\n': {
          if (ch === '\r' && data[i] === '\n') i++;
          const line = this.line;
          this.options.write('\r\n');
          if (line.trim() && this.options.history[this.options.history.length - 1] !== line) this.options.history.push(line);
          this.line = '';
          this.cursor = 0;
          return { event: { type: 'line', line }, rest: data.slice(i) };
        }
        case '\x03':
          this.options.write('^C\r\n');
          this.line = '';
          this.cursor = 0;
          return { event: { type: 'interrupt' }, rest: data.slice(i) };
        case '\x04':
          if (!this.line) return { event: { type: 'eof' }, rest: data.slice(i) };
          this.key('delete');
          break;
        case '\x7f':
        case '\b':
          if (this.cursor > 0) {
            this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
            this.cursor--;
            this.redraw();
          }
          break;
        case '\x01':
          this.key('home');
          break;
        case '\x05':
          this.key('end');
          break;
        case '\x02':
          this.key('left');
          break;
        case '\x06':
          this.key('right');
          break;
        case '\x10':
          this.key('up');
          break;
        case '\x0e':
          this.key('down');
          break;
        case '\x15':
          this.line = this.line.slice(this.cursor);
          this.cursor = 0;
          this.redraw();
          break;
        case '\x0b':
          this.line = this.line.slice(0, this.cursor);
          this.redraw();
          break;
        case '\x17': {
          const before = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '');
          this.line = before + this.line.slice(this.cursor);
          this.cursor = before.length;
          this.redraw();
          break;
        }
        case '\x0c':
          this.options.write('\x1b[2J\x1b[H');
          this.redraw();
          break;
        case '\t':
          this.complete();
          break;
        default:
          if (ch >= ' ') this.insert(ch);
      }
    }
    return { rest: '' };
  }

  private insert(text: string): void {
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
    this.cursor += text.length;
    if (this.cursor === this.line.length) this.options.write(text);
    else this.redraw();
  }

  private key(name: string): void {
    const history = this.options.history;
    switch (name) {
      case 'left':
        if (this.cursor > 0) {
          this.cursor--;
          this.options.write('\x1b[D');
        }
        return;
      case 'right':
        if (this.cursor < this.line.length) {
          this.cursor++;
          this.options.write('\x1b[C');
        }
        return;
      case 'wordLeft':
        this.cursor = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '').length;
        return this.redraw();
      case 'wordRight': {
        const m = /^\s*\S+/.exec(this.line.slice(this.cursor));
        this.cursor += m ? m[0].length : 0;
        return this.redraw();
      }
      case 'home':
        this.cursor = 0;
        return this.redraw();
      case 'end':
        this.cursor = this.line.length;
        return this.redraw();
      case 'delete':
        if (this.cursor < this.line.length) {
          this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
          this.redraw();
        }
        return;
      case 'up':
        if (!history.length) return;
        if (this.historyIndex === -1) {
          this.draft = this.line;
          this.historyIndex = history.length - 1;
        } else if (this.historyIndex > 0) this.historyIndex--;
        this.line = history[this.historyIndex]!;
        this.cursor = this.line.length;
        return this.redraw();
      case 'down':
        if (this.historyIndex === -1) return;
        this.historyIndex++;
        if (this.historyIndex >= history.length) {
          this.historyIndex = -1;
          this.line = this.draft;
        } else this.line = history[this.historyIndex]!;
        this.cursor = this.line.length;
        return this.redraw();
    }
  }

  private complete(): void {
    const before = this.line.slice(0, this.cursor);
    const word = /\S*$/.exec(before)![0];
    const candidates = this.options.complete?.(before, word) ?? [];
    if (!candidates.length) return;
    if (candidates.length === 1) {
      const only = candidates[0]!;
      this.insert(only.slice(word.length) + (only.endsWith('/') ? '' : ' '));
      return;
    }
    const prefix = commonPrefix(candidates);
    if (prefix.length > word.length) {
      this.insert(prefix.slice(word.length));
      return;
    }
    this.options.write('\r\n' + candidates.map((c) => c.slice(c.lastIndexOf('/', c.length - 2) + 1)).join('  ') + '\r\n');
    this.redraw();
  }

  /** Repaint the prompt and line, then put the terminal cursor back where ours is. */
  redraw(): void {
    const back = this.line.length - this.cursor;
    this.options.write(`\r\x1b[K${this.prompt}${this.line}${back ? `\x1b[${back}D` : ''}`);
  }
}
