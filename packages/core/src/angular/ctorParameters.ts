import { matchBracket, matchesAtDepthZero, skipSpace, splitTopLevel, trimRange, type Range } from './scanner.js';
import { applyEdits, findDecoratedClasses, type Edit } from './syntax.js';
import { exportNamed, scanSource, typeOnlyNames, valuesFrom, type ModuleValues, type ScannedSource } from './imports.js';

/**
 * Constructor dependency injection without `emitDecoratorMetadata`. Angular's
 * JIT reads a class's constructor parameters from a static `ctorParameters`
 * function — the shape Angular's own downlevel-decorators transform emits — so
 * every Angular-decorated class with constructor parameters gets one:
 *
 *   static ctorParameters = () => [{ type: Http }, { type: undefined, decorators: [{ type: Inject, args: [TOKEN] }] }];
 *
 * Each parameter's type becomes a value the way Angular's transform maps it
 * (`typeReferenceToExpression`): `T | null` / `T | undefined` → `T`; `string`,
 * `number`, `boolean` → `String`, `Number`, `Boolean`; function types →
 * `Function`; arrays and tuples → `Array`; a type reference → that reference,
 * type arguments dropped; anything else → `undefined`. An `undefined` type is
 * not an error here: Angular raises its own NG0202 if that parameter is ever
 * actually injected (with no @Inject).
 *
 * When `ctorParameters` is present Angular ignores the `__parameters__` the
 * parameter decorators record, so Angular's parameter decorators (@Inject,
 * @Optional, @Self, @SkipSelf, @Host, @Attribute — recognised through the
 * file's imports from `@angular/core`, aliases and namespaces included) are
 * carried in `decorators`; any other parameter decorator is left to the
 * TypeScript compiler. The arrow keeps the types lazy, so `forwardRef` and
 * circular imports still work.
 */

const ANGULAR_CLASS_DECORATORS = ['Component', 'Directive', 'Pipe', 'Injectable', 'NgModule'];
const PARAM_DECORATORS = new Set(['Inject', 'Optional', 'Self', 'SkipSelf', 'Host', 'Attribute']);
/** Parameter decorators that name the injection token themselves, so the declared type does not matter. */
const TOKEN_DECORATORS = new Set(['Inject', 'Attribute']);
const WRAPPERS: Record<string, string> = { string: 'String', number: 'Number', boolean: 'Boolean' };
/** Keywords and literal types: no runtime value a type reference could name. */
const NOT_VALUES = new Set(['bigint', 'symbol', 'object', 'any', 'unknown', 'never', 'void', 'undefined', 'null', 'this', 'true', 'false']);
const TYPE_REFERENCE = /^([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(<[\s\S]*>)?$/;
const MODIFIERS = /^(?:(?:public|private|protected|readonly|override)\s+)*/;

interface ParamDecorator {
  /** The decorator expression as written (`Inject`, an alias, `ng.Inject`). */
  expression: string;
  /** The `@angular/core` export it names, when it is one. */
  angular?: string;
  /** The argument list's source, without the parentheses; undefined when not called. */
  args?: string;
}

interface Parameter {
  decorators: ParamDecorator[];
  /** The annotation (source text and its masked twin), when there is one. */
  type?: { source: string; masked: string };
}

/** Leading `@Name(args)` decorators of one parameter, and the index past them. */
function readDecorators(source: string, masked: string, range: Range, core: ModuleValues): { decorators: ParamDecorator[]; rest: number } {
  const decorators: ParamDecorator[] = [];
  let i = skipSpace(masked, range.start);
  while (i < range.end && masked[i] === '@') {
    const m = /^@\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*/.exec(masked.slice(i, range.end));
    if (!m) break;
    i += m[0].length;
    let args: string | undefined;
    if (masked[i] === '(') {
      const close = matchBracket(masked, i);
      args = source.slice(i + 1, close).trim();
      i = skipSpace(masked, close + 1);
    }
    const expression = m[1]!.replace(/\s+/g, '');
    const angular = exportNamed(core, expression);
    decorators.push({ expression, angular: angular && PARAM_DECORATORS.has(angular) ? angular : undefined, args });
  }
  return { decorators, rest: i };
}

function readParameter(source: string, masked: string, range: Range, core: ModuleValues): Parameter {
  const { decorators, rest } = readDecorators(source, masked, range, core);
  let i = rest + (MODIFIERS.exec(masked.slice(rest, range.end))?.[0].length ?? 0);
  const head = /^(\.\.\.)?\s*([A-Za-z_$][\w$]*)\s*\??\s*/.exec(masked.slice(i, range.end));
  if (!head || head[1]) return { decorators };
  i += head[0].length;
  if (masked[i] !== ':') return { decorators };
  // The annotation runs to a top-level `=` (a default value) or the end.
  const typeStart = i + 1;
  const parts = splitTopLevel(masked.replace(/=(?!>)/g, ','), typeStart, range.end, { angles: true });
  const typeRange = trimRange(masked, { start: typeStart, end: parts[0]?.end ?? range.end });
  return { decorators, type: { source: source.slice(typeRange.start, typeRange.end), masked: masked.slice(typeRange.start, typeRange.end) } };
}

/** Top-level `|` members of a (masked) type, trimmed, empty ones (a leading `|`) dropped. */
function unionMembers(masked: string): Range[] {
  const out: Range[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i <= masked.length; i++) {
    const ch = masked[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && masked[i - 1] !== '=')) depth--;
    else if (i === masked.length || (ch === '|' && depth === 0)) {
      const range = trimRange(masked, { start: from, end: i });
      if (range.end > range.start) out.push(range);
      from = i + 1;
    }
  }
  return out;
}

/** True when the whole (masked) text is one bracket group opened by `open`. */
const isGroup = (masked: string, open: string) => masked[0] === open && matchBracket(masked, 0) === masked.length - 1;

/** The runtime value naming a parameter's type, as Angular's transform maps it; undefined when there is none. */
function typeExpression(source: string, masked: string, typeOnly: ReadonlySet<string>): string | undefined {
  let [text, shape] = [source, masked];
  // `(T)`: the type inside the parentheses.
  while (isGroup(shape, '(')) {
    const inner = trimRange(shape, { start: 1, end: shape.length - 1 });
    [text, shape] = [text.slice(inner.start, inner.end), shape.slice(inner.start, inner.end)];
  }
  const members = unionMembers(shape);
  if (members.length > 1) {
    const kept = members.filter((r) => !/^(null|undefined)$/.test(shape.slice(r.start, r.end)));
    return kept.length === 1 ? typeExpression(text.slice(kept[0]!.start, kept[0]!.end), shape.slice(kept[0]!.start, kept[0]!.end), typeOnly) : undefined;
  }
  if (WRAPPERS[shape]) return WRAPPERS[shape];
  if (/\]$/.test(shape) || /^readonly\s/.test(shape)) return 'Array';
  const m = TYPE_REFERENCE.exec(text);
  if (!m) return shape.includes('=>') ? 'Function' : undefined;
  const name = m[1]!.replace(/\s+/g, '');
  // A name imported with `import type` (or `import { type X }`) has no value at
  // runtime: referencing it would throw a ReferenceError when Angular reads
  // ctorParameters. Without @Inject such a parameter is not injectable anyway,
  // so it gets `undefined`, and Angular reports NG0202 if it is ever injected.
  if (NOT_VALUES.has(name) || typeOnly.has(name.split('.')[0]!)) return undefined;
  return name;
}

function describe(parameter: Parameter, typeOnly: ReadonlySet<string>): string {
  const angular = parameter.decorators.filter((decorator) => decorator.angular);
  const tokened = angular.some((decorator) => TOKEN_DECORATORS.has(decorator.angular!));
  const type = (!tokened && parameter.type && typeExpression(parameter.type.source, parameter.type.masked, typeOnly)) || 'undefined';
  if (!angular.length) return `{ type: ${type} }`;
  const decorators = angular.map((d) => `{ type: ${d.expression}${d.args !== undefined ? `, args: [${d.args}]` : ''} }`);
  return `{ type: ${type}, decorators: [${decorators.join(', ')}] }`;
}

/** The edits adding `ctorParameters` to every Angular class that injects through its constructor (see {@link ScannedSource}). */
export function ctorParameterEdits({ source, masked, imports }: ScannedSource): Edit[] {
  const edits: Edit[] = [];
  if (!source.includes('constructor')) return edits;
  const core = valuesFrom(imports, '@angular/core');
  const typeOnly = typeOnlyNames(imports);
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
    const params = splitTopLevel(masked, open + 1, matchBracket(masked, open), { angles: true }).map((range) => readParameter(source, masked, range, core));
    if (!params.length) continue;
    const list = params.map((parameter) => describe(parameter, typeOnly)).join(', ');
    edits.push({ start: bodyStart, end: bodyStart, text: ` static ctorParameters = () => [${list}];` });
  }
  return edits;
}

export function addCtorParameters(source: string): string {
  const edits = ctorParameterEdits(scanSource(source));
  return edits.length ? applyEdits(source, edits) : source;
}
