/**
 * The shell grammar, a practical subset of POSIX sh:
 *
 *   script    := list (('\n' | ';' | '&') list)*
 *   list      := pipeline (('&&' | '||') pipeline)*
 *   pipeline  := ['!'] command ('|' command)*
 *   command   := simple | compound redirect* | function
 *   simple    := (NAME=word)* word* redirect*
 *   compound  := if … then … [elif … then …]* [else …] fi
 *              | while|until … do … done | for NAME [in word*] do … done
 *              | case word in (pattern [| pattern]*) … ;; … esac
 *              | '{' script '}' | '(' script ')'
 *   function  := NAME '(' ')' compound | 'function' NAME ['(' ')'] compound
 *   redirect  := ('>' | '>>' | '<' | '2>' | '2>>' | '&>') word | '2>&1' | '>&2' | ('<<' | '<<-') DELIM
 *
 * Reserved words count only in command position and unquoted, as in sh, so
 * `echo done` prints "done".
 */
import type { AndOrList, CaseCommand, Command, CompoundCommand, ForCommand, IfCommand, LoopCommand, Pipeline, Redirect, RedirectOp, Script, Segment, SimpleCommand, Word } from './ast.js';
import { ShellSyntaxError, tokenize, type Token } from './tokenize.js';

export type * from './ast.js';
export { ShellSyntaxError, tokenize } from './tokenize.js';

const ASSIGNMENT = /^([A-Za-z_]\w*)=/;
const NAME = /^[A-Za-z_][\w-]*$/;
const REDIRECTS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '2>&1', '>&2', '<<', '<<-']);
/** Words that end a nested list; never the start of a command. */
const CLOSERS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);

export function parse(input: string): Script {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const isOp = (op: string) => {
    const t = tokens[pos];
    return t?.type === 'op' && t.op === op;
  };
  const isWord = (raw: string, at = pos) => {
    const t = tokens[at];
    return t?.type === 'word' && t.raw === raw;
  };
  const describe = (t: Token | undefined) => (!t ? 'end of input' : t.type === 'op' ? `\`${t.op.replace('\n', 'newline')}'` : t.type === 'word' ? `\`${t.raw}'` : 'here-document');
  const fail = (t: Token | undefined): never => {
    throw new ShellSyntaxError(t ? `syntax error near unexpected token ${describe(t)}` : 'unexpected end of input', !t);
  };
  const skipNewlines = () => {
    while (isOp('\n')) pos++;
  };
  const skipSeparators = () => {
    while (isOp('\n') || isOp(';')) pos++;
  };
  const expectWord = (raw: string) => {
    skipSeparators();
    if (!isWord(raw)) fail(peek());
    pos++;
  };

  const redirect = (cmd: { redirects: Redirect[] }): boolean => {
    const t = peek();
    if (t?.type !== 'op' || !REDIRECTS.has(t.op)) return false;
    pos++;
    if (t.op === '2>&1' || t.op === '>&2') {
      cmd.redirects.push({ op: t.op });
      return true;
    }
    const target = peek();
    if (t.op === '<<' || t.op === '<<-') {
      if (target?.type !== 'heredoc' || !target.body) fail(target);
      pos++;
      cmd.redirects.push({ op: t.op, heredoc: { body: (target as { body: Word }).body } });
      return true;
    }
    if (target?.type !== 'word') fail(target);
    pos++;
    cmd.redirects.push({ op: t.op as RedirectOp, target: (target as { word: Word }).word });
    return true;
  };

  const simple = (): SimpleCommand => {
    const cmd: SimpleCommand = { type: 'simple', assignments: [], words: [], redirects: [] };
    for (;;) {
      const t = peek();
      if (!t || t.type === 'heredoc') break;
      if (t.type === 'op') {
        if (!redirect(cmd)) break;
        continue;
      }
      pos++;
      const first = t.word[0];
      const m = !cmd.words.length && first?.kind === 'text' && !first.quoted ? ASSIGNMENT.exec(first.value) : null;
      if (m) {
        const rest = first!.kind === 'text' ? first!.value.slice(m[0].length) : '';
        cmd.assignments.push({ name: m[1]!, value: [...(rest ? [{ kind: 'text', value: rest, quoted: false } as Segment] : []), ...t.word.slice(1)] });
      } else cmd.words.push(t.word);
    }
    return cmd;
  };

  /** A nested list, up to (not including) one of `stops`. */
  const list = (stops: ReadonlySet<string>, stopOps: ReadonlySet<string> = new Set()): Script => {
    const script: Script = [];
    for (;;) {
      skipSeparators();
      const t = peek();
      if (!t) fail(t);
      if (t!.type === 'word' && stops.has(t!.raw)) return script;
      if (t!.type === 'op' && stopOps.has(t!.op)) return script;
      script.push(andOr());
      if (isOp('&')) {
        script[script.length - 1]!.background = true;
        pos++;
      }
    }
  };

  const ifCommand = (): IfCommand => {
    pos++; // if
    const clauses: IfCommand['clauses'] = [];
    let otherwise: Script | undefined;
    const condition = list(new Set(['then']));
    expectWord('then');
    clauses.push({ condition, body: list(new Set(['elif', 'else', 'fi'])) });
    for (;;) {
      if (isWord('elif')) {
        pos++;
        const next = list(new Set(['then']));
        expectWord('then');
        clauses.push({ condition: next, body: list(new Set(['elif', 'else', 'fi'])) });
      } else if (isWord('else')) {
        pos++;
        otherwise = list(new Set(['fi']));
      } else break;
    }
    expectWord('fi');
    return { type: 'if', clauses, otherwise, redirects: [] };
  };

  const doBody = (): Script => {
    expectWord('do');
    const body = list(new Set(['done']));
    expectWord('done');
    return body;
  };

  const loop = (type: 'while' | 'until'): LoopCommand => {
    pos++;
    const condition = list(new Set(['do']));
    return { type, condition, body: doBody(), redirects: [] };
  };

  const forCommand = (): ForCommand => {
    pos++; // for
    const t = peek();
    if (t?.type !== 'word' || !NAME.test(t.raw)) fail(t);
    const name = (t as { raw: string }).raw;
    pos++;
    skipNewlines();
    let items: Word[] | undefined;
    if (isWord('in')) {
      pos++;
      items = [];
      while (peek()?.type === 'word') items.push((tokens[pos++] as { word: Word }).word);
    }
    return { type: 'for', name, items, body: doBody(), redirects: [] };
  };

  const caseCommand = (): CaseCommand => {
    pos++; // case
    const subject = peek();
    if (subject?.type !== 'word') fail(subject);
    pos++;
    skipNewlines();
    if (!isWord('in')) fail(peek());
    pos++;
    const arms: CaseCommand['arms'] = [];
    for (;;) {
      skipSeparators();
      if (isWord('esac')) break;
      if (isOp('(')) pos++;
      const patterns: Word[] = [];
      for (;;) {
        const p = peek();
        if (p?.type !== 'word') fail(p);
        patterns.push((p as { word: Word }).word);
        pos++;
        if (isOp('|')) pos++;
        else break;
      }
      if (!isOp(')')) fail(peek());
      pos++;
      const body = list(new Set(['esac']), new Set([';;']));
      arms.push({ patterns, body });
      if (isOp(';;')) pos++;
    }
    pos++; // esac
    return { type: 'case', subject: (subject as { word: Word }).word, arms, redirects: [] };
  };

  const compound = (): CompoundCommand | undefined => {
    let node: CompoundCommand | undefined;
    if (isWord('if')) node = ifCommand();
    else if (isWord('while')) node = loop('while');
    else if (isWord('until')) node = loop('until');
    else if (isWord('for')) node = forCommand();
    else if (isWord('case')) node = caseCommand();
    else if (isWord('{')) {
      pos++;
      const body = list(new Set(['}']));
      pos++;
      node = { type: 'group', body, redirects: [] };
    } else if (isOp('(')) {
      pos++;
      const body = list(new Set(), new Set([')']));
      pos++;
      node = { type: 'subshell', body, redirects: [] };
    }
    if (node) while (redirect(node));
    return node;
  };

  const command = (): Command => {
    const t = peek();
    if (t?.type === 'word' && CLOSERS.has(t.raw)) fail(t);
    const block = compound();
    if (block) return block;
    // function NAME [()] body  |  NAME () body
    const named = isWord('function') ? 1 : 0;
    const nameToken = tokens[pos + named];
    if (nameToken?.type === 'word' && NAME.test(nameToken.raw)) {
      const parens = tokens[pos + named + 1]?.type === 'op' && (tokens[pos + named + 1] as { op: string }).op === '(';
      if (named || parens) {
        pos += named + 1;
        if (parens) {
          pos++;
          if (!isOp(')')) fail(peek());
          pos++;
        }
        skipNewlines();
        const body = compound();
        if (!body) fail(peek());
        return { type: 'function', name: nameToken.raw, body: body!, redirects: [] };
      }
    }
    return simple();
  };

  const pipeline = (): Pipeline => {
    let negate = false;
    if (isWord('!')) {
      negate = true;
      pos++;
    }
    const commands = [command()];
    while (isOp('|')) {
      pos++;
      skipNewlines();
      if (!peek()) throw new ShellSyntaxError('unexpected end of input after |', true);
      commands.push(command());
    }
    for (const c of commands) if (c.type === 'simple' && !c.words.length && !c.assignments.length && !c.redirects.length) fail(peek() ?? { type: 'op', op: '|' });
    return { negate, commands };
  };

  const andOr = (): AndOrList => {
    const t = peek()!;
    if (t.type === 'op' && !REDIRECTS.has(t.op) && t.op !== '(') fail(t);
    const result: AndOrList = { first: pipeline(), rest: [], background: false };
    while (isOp('&&') || isOp('||')) {
      const op = (tokens[pos] as { op: '&&' | '||' }).op;
      pos++;
      skipNewlines();
      if (!peek()) throw new ShellSyntaxError(`unexpected end of input after ${op}`, true);
      result.rest.push({ op, pipeline: pipeline() });
    }
    return result;
  };

  const script: Script = [];
  while (pos < tokens.length) {
    if (isOp(';') || isOp('\n')) {
      pos++;
      continue;
    }
    script.push(andOr());
    if (isOp('&')) {
      script[script.length - 1]!.background = true;
      pos++;
    }
  }
  return script;
}
