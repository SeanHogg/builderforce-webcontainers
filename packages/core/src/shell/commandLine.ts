/**
 * Command lines read with the shell's own tokenizer, so quoting means what it
 * means in `bfsh`:
 *
 * - `splitCommandLine`: a line (`npm run dev`, `uvicorn main:app --port 8000`,
 *   `"/path with space/node" server.js`) as the program and its leading
 *   arguments. A line that needs a shell to mean what it says — operators (`&&`,
 *   `|`, `;`, redirects), an environment assignment (`FOO=1 cmd`), an expansion
 *   (`$VAR`, `$(…)`, `~`) or an unquoted glob — is reported as `shell`, never
 *   split into words that would change its meaning.
 * - `shellCommandWords`: the words of every simple command in a line (after
 *   their leading assignments, command substitutions included), so a policy can
 *   see each program a shell line runs.
 */
import type { Word } from './ast.js';
import { ShellSyntaxError, tokenize, type Token } from './tokenize.js';

export type CommandLine =
  /** Plain words: `argv[0]` is the program, the rest its leading arguments. */
  | { kind: 'argv'; argv: string[]; strayBackslash: boolean }
  /** The line needs a shell (`bfsh -c <line>`). */
  | { kind: 'shell'; line: string; strayBackslash: boolean }
  /** The line does not parse (an unterminated quote) or holds no command. */
  | { kind: 'invalid'; reason: string };

const ASSIGNMENT = /^[A-Za-z_]\w*=/;
/** Characters a backslash escapes to nothing but themselves: `\s` in `.\server.js` is just `s`, the backslash is lost. */
const ORDINARY = /[A-Za-z0-9._/:,@+-]/;
/** A bracketed IPv6 literal (`[::]`, `[::1]`, `[fe80::1%eth0]`), not a glob class. */
const IPV6_BRACKET = /^\[[0-9A-Fa-f.]*:[0-9A-Fa-f:.%\w]*\]/;
/** Redirects whose next word is their target, not an argument. */
const REDIRECT_WITH_TARGET = new Set(['>', '>>', '<', '2>', '2>>', '&>', '<<', '<<-']);

interface RawScan {
  /** An unquoted, unescaped `*`, `?` or `[` the shell would expand. */
  glob: boolean;
  /** An unquoted backslash before an ordinary character: the tokenizer drops it (`C:\app` reads `C:app`). */
  strayBackslash: boolean;
}

/** What a word's raw text holds outside quotes and escapes. */
function scanRaw(raw: string): RawScan {
  const scan: RawScan = { glob: false, strayBackslash: false };
  // A URL's `?` and a host's `[…]` are text, not a pattern.
  const url = raw.includes('://');
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "'") {
      const end = raw.indexOf("'", i + 1);
      i = end < 0 ? raw.length : end;
    } else if (c === '"') {
      for (i++; i < raw.length && raw[i] !== '"'; i++) if (raw[i] === '\\') i++;
    } else if (c === '\\') {
      if (ORDINARY.test(raw[i + 1] ?? '')) scan.strayBackslash = true;
      i++;
    } else if (!url && (c === '*' || c === '?')) {
      scan.glob = true;
    } else if (!url && c === '[') {
      const ipv6 = IPV6_BRACKET.exec(raw.slice(i));
      if (ipv6) i += ipv6[0].length - 1;
      else scan.glob = true;
    }
  }
  return scan;
}

/** The literal text of a word made only of text segments, or undefined when it expands. */
function literal(word: Word): string | undefined {
  let text = '';
  for (const segment of word) {
    if (segment.kind !== 'text') return undefined;
    text += segment.value;
  }
  return text;
}

const isAssignment = (word: Word) => word[0]?.kind === 'text' && !word[0].quoted && ASSIGNMENT.test(word[0].value);

function tokensOf(line: string): Token[] | ShellSyntaxError {
  try {
    return tokenize(line.trim());
  } catch (error) {
    if (error instanceof ShellSyntaxError) return error;
    throw error;
  }
}

export function splitCommandLine(line: string): CommandLine {
  const tokens = tokensOf(line);
  if (tokens instanceof ShellSyntaxError) return { kind: 'invalid', reason: tokens.message };
  if (tokens.length === 0) return { kind: 'invalid', reason: 'empty command' };
  const argv: string[] = [];
  let shell = false;
  let strayBackslash = false;
  for (const token of tokens) {
    if (token.type !== 'word') {
      shell = true;
      continue;
    }
    const scan = scanRaw(token.raw);
    strayBackslash ||= scan.strayBackslash;
    const text = literal(token.word);
    // `FOO=1 cmd`: an unquoted leading assignment is the shell's, not the program's name.
    if (text === undefined || scan.glob || (argv.length === 0 && isAssignment(token.word))) shell = true;
    else argv.push(text);
  }
  if (shell) return { kind: 'shell', line: line.trim(), strayBackslash };
  return { kind: 'argv', argv, strayBackslash };
}

/**
 * The words of each simple command in `line` (`cd infra && docker compose up` →
 * `[['cd', 'infra'], ['docker', 'compose', 'up']]`), after their leading
 * assignments and without redirect targets. A word that expands keeps its raw
 * text. A line that does not parse has none.
 */
export function shellCommandWords(line: string): string[][] {
  const tokens = tokensOf(line);
  if (tokens instanceof ShellSyntaxError) return [];
  const commands: string[][] = [];
  // `$(…)` and backticks run commands of their own, wherever the word sits (redirect targets and assignments too).
  const substitutions = (word: Word): void => {
    for (const segment of word) {
      if (segment.kind === 'cmd') commands.push(...shellCommandWords(segment.source));
      else if (segment.kind === 'var' && segment.arg) substitutions(segment.arg);
    }
  };
  let current: string[] = [];
  let skipTarget = false;
  const end = () => {
    if (current.length > 0) commands.push(current);
    current = [];
  };
  for (const token of tokens) {
    if (token.type === 'heredoc') continue;
    if (token.type === 'op') {
      if (REDIRECT_WITH_TARGET.has(token.op)) skipTarget = true;
      else if (token.op !== '2>&1' && token.op !== '>&2') end();
      continue;
    }
    substitutions(token.word);
    if (skipTarget) {
      skipTarget = false;
      continue;
    }
    if (current.length === 0 && isAssignment(token.word)) continue;
    current.push(literal(token.word) ?? token.raw);
  }
  end();
  return commands;
}
