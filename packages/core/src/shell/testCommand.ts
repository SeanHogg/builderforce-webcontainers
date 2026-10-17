/**
 * `test` and `[ … ]`: file tests (-e -f -d -s -r -w -x), string tests (-z -n,
 * = == !=), integer comparisons (-eq -ne -lt -le -gt -ge), `!`, `-a`/`-o` and
 * parentheses. Exit 0 for true, 1 for false, 2 for a malformed expression.
 */
import type { Command, CommandContext } from './context.js';
import { resolvePath } from './context.js';

class TestSyntaxError extends Error {}

const FILE_TESTS = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h']);
const INT_OPS = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);

function evaluate(ctx: CommandContext, args: string[]): boolean {
  let pos = 0;
  const peek = () => args[pos];
  const next = () => {
    if (pos >= args.length) throw new TestSyntaxError('argument expected');
    return args[pos++]!;
  };
  const integer = (value: string) => {
    if (!/^\s*-?\d+\s*$/.test(value)) throw new TestSyntaxError(`${value}: integer expression expected`);
    return Number(value);
  };

  const primary = (): boolean => {
    const token = next();
    if (token === '!') return !primary();
    if (token === '(') {
      const value = or();
      if (next() !== ')') throw new TestSyntaxError("')' expected");
      return value;
    }
    const op = peek();
    if (op !== undefined && (op === '=' || op === '==' || op === '!=' || INT_OPS.has(op)) && args[pos + 1] !== undefined) {
      pos++;
      const right = next();
      if (op === '=' || op === '==') return token === right;
      if (op === '!=') return token !== right;
      const [a, b] = [integer(token), integer(right)];
      return op === '-eq' ? a === b : op === '-ne' ? a !== b : op === '-lt' ? a < b : op === '-le' ? a <= b : op === '-gt' ? a > b : a >= b;
    }
    if (token === '-z' && peek() !== undefined) return next().length === 0;
    if (token === '-n' && peek() !== undefined) return next().length > 0;
    if (FILE_TESTS.has(token) && peek() !== undefined) {
      const path = resolvePath(ctx, next());
      const fs = ctx.fs;
      switch (token) {
        case '-f': return fs.isFile(path);
        case '-d': return fs.isDirectory(path);
        case '-s': {
          const contents = fs.readFile(path);
          return contents !== undefined && contents.length > 0;
        }
        case '-L':
        case '-h': return false;
        default: return fs.exists(path);
      }
    }
    return token.length > 0;
  };
  const and = (): boolean => {
    let value = primary();
    while (peek() === '-a') {
      pos++;
      const right = primary();
      value = value && right;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (peek() === '-o') {
      pos++;
      const right = and();
      value = value || right;
    }
    return value;
  };

  if (!args.length) return false;
  const result = or();
  if (pos < args.length) throw new TestSyntaxError(`${args[pos]}: unexpected argument`);
  return result;
}

function run(ctx: CommandContext, args: string[]): number {
  try {
    return evaluate(ctx, args) ? 0 : 1;
  } catch (error) {
    if (!(error instanceof TestSyntaxError)) throw error;
    ctx.io.stderr(`${ctx.name}: ${error.message}\n`);
    return 2;
  }
}

export const test: Command = async (ctx) => run(ctx, ctx.args);

export const bracket: Command = async (ctx) => {
  if (ctx.args[ctx.args.length - 1] !== ']') {
    ctx.io.stderr("[: missing ']'\n");
    return 2;
  }
  return run(ctx, ctx.args.slice(0, -1));
};
