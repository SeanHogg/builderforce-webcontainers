import { applyEdits, findDecoratedClasses, maskCode, matchBracket, matchesAtDepthZero, skipSpace, splitTopLevel, trimRange, type Edit, type Range } from './scanner.js';

/**
 * Constructor dependency injection without `emitDecoratorMetadata`. Angular's
 * JIT reads a class's constructor parameters from a static `ctorParameters`
 * function — the shape Angular's own downlevel-decorators transform emits — so
 * every Angular-decorated class with constructor parameters gets one:
 *
 *   static ctorParameters = () => [{ type: Http }, { type: undefined, decorators: [{ type: Inject, args: [TOKEN] }] }];
 *
 * When `ctorParameters` is present Angular ignores the `__parameters__` the
 * parameter decorators record, so @Inject/@Optional/@Self/… are carried in
 * `decorators` (their identifiers are already imported by the source). The
 * arrow keeps the types lazy, so `forwardRef` and circular imports still work.
 */

const ANGULAR_CLASS_DECORATORS = ['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule'];
/** Parameter decorators that name the injection token themselves, so the declared type does not matter. */
const TOKEN_DECORATORS = new Set(['Inject', 'Attribute']);
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'any', 'unknown', 'never', 'void', 'undefined', 'null', 'this']);
const TYPE_REFERENCE = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(<[\s\S]*>)?$/;
const MODIFIERS = /^(?:(?:public|private|protected|readonly|override)\s+)*/;

interface ParamDecorator {
  name: string;
  /** The argument list's source, without the parentheses; undefined when not called. */
  args?: string;
}

interface Parameter {
  name: string;
  decorators: ParamDecorator[];
  type?: string;
}

/** Leading `@Name(args)` decorators of one parameter, and the index past them. */
function readDecorators(source: string, masked: string, range: Range): { decorators: ParamDecorator[]; rest: number } {
  const decorators: ParamDecorator[] = [];
  let i = skipSpace(masked, range.start);
  while (i < range.end && masked[i] === '@') {
    const m = /^@\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*/.exec(masked.slice(i, range.end));
    if (!m) break;
    i += m[0].length;
    let args: string | undefined;
    if (masked[i] === '(') {
      const close = matchBracket(masked, i);
      args = source.slice(i + 1, close).trim();
      i = skipSpace(masked, close + 1);
    }
    decorators.push({ name: m[1]!, args });
  }
  return { decorators, rest: i };
}

function readParameter(source: string, masked: string, range: Range): Parameter {
  const { decorators, rest } = readDecorators(source, masked, range);
  let i = rest + (MODIFIERS.exec(masked.slice(rest, range.end))?.[0].length ?? 0);
  const head = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*\??\s*/.exec(masked.slice(i, range.end));
  const name = head?.[2] ?? masked.slice(i, range.end).trim();
  if (!head || head[1]) return { name, decorators };
  i += head[0].length;
  if (masked[i] !== ':') return { name, decorators };
  // The annotation runs to a top-level `=` (a default value) or the end.
  const typeStart = i + 1;
  const parts = splitTopLevel(masked.replace(/=(?!>)/g, ','), typeStart, range.end, { angles: true });
  const typeRange = trimRange(masked, { start: typeStart, end: parts[0]?.end ?? range.end });
  return { name, decorators, type: source.slice(typeRange.start, typeRange.end) };
}

/** The runtime value naming a parameter's type, or undefined when it has none. */
function typeExpression(type: string | undefined): string | undefined {
  if (!type) return undefined;
  const m = TYPE_REFERENCE.exec(type.trim());
  if (!m) return undefined;
  const name = m[1]!.replace(/\s+/g, '');
  return PRIMITIVES.has(name) ? undefined : name;
}

function describe(file: string, className: string, parameter: Parameter): string {
  const tokened = parameter.decorators.some((decorator) => TOKEN_DECORATORS.has(decorator.name));
  const type = tokened ? 'undefined' : typeExpression(parameter.type);
  if (!type) {
    throw new Error(
      `${file}: constructor parameter '${parameter.name}' of ${className} has no injectable type. ` +
        'Use @Inject(TOKEN) or switch to inject() (https://angular.dev/api/core/inject).',
    );
  }
  if (!parameter.decorators.length) return `{ type: ${type} }`;
  const decorators = parameter.decorators.map((d) => `{ type: ${d.name}${d.args !== undefined ? `, args: [${d.args}]` : ''} }`);
  return `{ type: ${type}, decorators: [${decorators.join(', ')}] }`;
}

export function addCtorParameters(source: string, file: string): string {
  if (!source.includes('constructor')) return source;
  const masked = maskCode(source);
  const edits: Edit[] = [];
  for (const cls of findDecoratedClasses(masked, ANGULAR_CLASS_DECORATORS)) {
    const bodyStart = cls.bodyOpen + 1;
    if (matchesAtDepthZero(masked, bodyStart, cls.bodyClose, /\bctorParameters\b/g).length) continue;
    // The implementation signature: the constructor followed by a body, not an overload.
    const ctor = matchesAtDepthZero(masked, bodyStart, cls.bodyClose, /\bconstructor\s*\(/g).find((m) => {
      const close = matchBracket(masked, m.index + m[0].length - 1);
      return masked[skipSpace(masked, close + 1)] === '{';
    });
    if (!ctor) continue;
    const open = ctor.index + ctor[0].length - 1;
    const params = splitTopLevel(masked, open + 1, matchBracket(masked, open), { angles: true }).map((range) => readParameter(source, masked, range));
    if (!params.length) continue;
    const list = params.map((parameter) => describe(file, cls.name, parameter)).join(', ');
    edits.push({ start: bodyStart, end: bodyStart, text: ` static ctorParameters = () => [${list}];` });
  }
  return edits.length ? applyEdits(source, edits) : source;
}
