/**
 * The shell's syntax tree. Words keep their quoting as segments, because
 * expansion (variables, `$(…)`, `~`, globs, field splitting) happens at run
 * time and depends on it.
 */

export type Segment =
  | { kind: 'text'; value: string; quoted: boolean }
  | { kind: 'var'; name: string; quoted: boolean; op?: ':-' | '-' | ':=' | ':+'; arg?: Word }
  | { kind: 'cmd'; source: string; quoted: boolean }
  | { kind: 'tilde' };
export type Word = Segment[];

export type RedirectOp = '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1' | '>&2' | '<<' | '<<-';
export interface Redirect {
  op: RedirectOp;
  target?: Word;
  /** A here-document's body; expanded like a double-quoted string unless the delimiter was quoted. */
  heredoc?: { body: Word };
}

export interface SimpleCommand {
  type: 'simple';
  assignments: Array<{ name: string; value: Word }>;
  words: Word[];
  redirects: Redirect[];
}

export interface IfCommand {
  type: 'if';
  clauses: Array<{ condition: Script; body: Script }>;
  otherwise?: Script;
  redirects: Redirect[];
}

export interface LoopCommand {
  type: 'while' | 'until';
  condition: Script;
  body: Script;
  redirects: Redirect[];
}

export interface ForCommand {
  type: 'for';
  name: string;
  /** Absent: iterate the positional parameters (`for x; do …`). */
  items?: Word[];
  body: Script;
  redirects: Redirect[];
}

export interface CaseCommand {
  type: 'case';
  subject: Word;
  arms: Array<{ patterns: Word[]; body: Script }>;
  redirects: Redirect[];
}

/** `{ list; }` runs in this shell; `( list )` in a copy of it. */
export interface GroupCommand {
  type: 'group' | 'subshell';
  body: Script;
  redirects: Redirect[];
}

export interface FunctionDefinition {
  type: 'function';
  name: string;
  body: CompoundCommand;
  redirects: Redirect[];
}

export type CompoundCommand = IfCommand | LoopCommand | ForCommand | CaseCommand | GroupCommand;
export type Command = SimpleCommand | CompoundCommand | FunctionDefinition;

export interface Pipeline {
  negate: boolean;
  commands: Command[];
}
export interface AndOrList {
  first: Pipeline;
  rest: Array<{ op: '&&' | '||'; pipeline: Pipeline }>;
  background: boolean;
}
export type Script = AndOrList[];
