/**
 * Running compound commands (`if`, `while`/`until`, `for`, `case`, `{ }`,
 * `( )`) against a narrow {@link ScriptRunner}, so the executor stays a
 * dispatcher. Loop control (`break`, `continue`) and `return` travel as a
 * {@link Flow} the runner holds: lists stop running while one is set, and the
 * construct it targets clears it.
 */
import type { CompoundCommand, Script, Word } from './ast.js';
import type { JobInput, ShellIO } from './exec.js';
import { patternToRegExp } from './expand.js';

export type Flow = { kind: 'break' | 'continue'; levels: number } | { kind: 'return'; status: number };

export interface ScriptRunner {
  flow?: Flow;
  readonly positional: readonly string[];
  runScript(script: Script, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number>;
  /** Words with splitting and globbing, as command arguments. */
  expandWords(words: Word[], io: ShellIO, signal: AbortSignal): Promise<string[]>;
  /** One word as a single string: no splitting, no globbing. */
  expandText(word: Word, io: ShellIO, signal: AbortSignal): Promise<string>;
  setVar(name: string, value: string): void;
  /** A copy of this shell for `( … )`: changes inside do not leak out. */
  subshell(): ScriptRunner;
}

/** After one pass of a loop body: whether the loop goes on. Consumes the flow aimed at this loop. */
function continueLoop(runner: ScriptRunner): boolean {
  const flow = runner.flow;
  if (!flow) return true;
  if (flow.kind === 'return') return false;
  if (flow.levels > 1) {
    runner.flow = { kind: flow.kind, levels: flow.levels - 1 };
    return false;
  }
  runner.flow = undefined;
  return flow.kind === 'continue';
}

export async function runCompound(node: CompoundCommand, runner: ScriptRunner, io: ShellIO, input: JobInput, signal: AbortSignal): Promise<number> {
  switch (node.type) {
    case 'group':
      return runner.runScript(node.body, io, input, signal);
    case 'subshell':
      return runner.subshell().runScript(node.body, io, input, signal);
    case 'if': {
      for (const clause of node.clauses) {
        const condition = await runner.runScript(clause.condition, io, input, signal);
        if (runner.flow) return condition;
        if (condition === 0) return runner.runScript(clause.body, io, input, signal);
      }
      return node.otherwise ? runner.runScript(node.otherwise, io, input, signal) : 0;
    }
    case 'while':
    case 'until': {
      let status = 0;
      while (!signal.aborted) {
        const condition = await runner.runScript(node.condition, io, input, signal);
        if (runner.flow && !continueLoop(runner)) break;
        if ((condition === 0) !== (node.type === 'while')) break;
        status = await runner.runScript(node.body, io, input, signal);
        if (!continueLoop(runner)) break;
      }
      return status;
    }
    case 'for': {
      const items = node.items ? await runner.expandWords(node.items, io, signal) : [...runner.positional];
      let status = 0;
      for (const item of items) {
        if (signal.aborted) break;
        runner.setVar(node.name, item);
        status = await runner.runScript(node.body, io, input, signal);
        if (!continueLoop(runner)) break;
      }
      return status;
    }
    case 'case': {
      const subject = await runner.expandText(node.subject, io, signal);
      for (const arm of node.arms) {
        for (const pattern of arm.patterns) {
          if (patternToRegExp(await runner.expandText(pattern, io, signal), { slash: true }).test(subject)) {
            return runner.runScript(arm.body, io, input, signal);
          }
        }
      }
      return 0;
    }
  }
}
