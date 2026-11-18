import { bracketDepths, matchBracket, matchesAtDepthZero, skipSpace, splitTopLevel, trimRange, type Range } from './scanner.js';
import { applyEdits, findDecoratedClasses, objectProperties, stringLiteralValue, type Edit } from './syntax.js';
import { scanSource, spellingsOf, valuesFrom, type ScannedSource } from './imports.js';

/**
 * Angular's JIT "initializer API" transform — what the Angular CLI applies in
 * JIT mode so signal-based members bind. Without it the JIT compiler never
 * learns that `name = input<string>()` is an input (NG0303), because it reads
 * inputs, outputs and queries from property decorators. Each such field gets
 * the decorator Angular's transform adds (compiler-cli
 * `transform/jit/src/initializer_api_transforms`, 17–20):
 *
 *   input / input.required  → @Input({ isSignal: true, alias, required, transform: undefined })
 *   model / model.required  → @Input({ isSignal: true, alias, required }) @Output(alias + 'Change')
 *   output / outputFromObservable → @Output(alias)
 *   viewChild(ren) / contentChild(ren) → @ViewChild(locator, { ...options, isSignal: true }) …
 *
 * Like Angular's transform, a call counts only when its function was imported
 * from Angular (`@angular/core`, or `@angular/core/rxjs-interop` for
 * `outputFromObservable`) — under any alias, or through a namespace import
 * (`ng.input()`); a local function that happens to be named `input` is left
 * alone. A member is found from its initializer: each depth-0 `= <fn>(` in a
 * class body, walked back to the field it initializes, so classes without
 * semicolons work too. The decorators are imported once, under names no source
 * would use.
 */

const SIGNAL_MODULES = [
  { module: '@angular/core', functions: ['input', 'model', 'output', 'viewChild', 'viewChildren', 'contentChild', 'contentChildren'] },
  { module: '@angular/core/rxjs-interop', functions: ['outputFromObservable'] },
] as const;

type SignalFunction = (typeof SIGNAL_MODULES)[number]['functions'][number];

const QUERY_DECORATORS: Partial<Record<SignalFunction, string>> = {
  viewChild: 'ViewChild',
  viewChildren: 'ViewChildren',
  contentChild: 'ContentChild',
  contentChildren: 'ContentChildren',
};

/** `ɵɵngJit<Name>` — the local name each decorator is imported under. */
const local = (decorator: string) => `ɵɵngJit${decorator}`;

/** A field declaration up to its `=`: modifiers, name, `?`/`!`, an optional type annotation. */
const MEMBER_HEAD = /^\s*((?:(?:public|private|protected|readonly|override|declare|accessor|static)\s+)*)([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::([\s\S]*))?$/;

/** Text that can be a type annotation: no statement end, no assignment, brackets balanced. */
function isTypeText(text: string): boolean {
  if (!text.trim() || text.includes(';') || /=(?!>)/.test(text)) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || (ch === '>' && text[i - 1] !== '=')) depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

/**
 * The field whose initializer starts at the `=` at `eq`: from the nearest
 * statement start before it (a line start, or after `;`, `}` or the class's `{`)
 * back to the first one at which a field declaration reads up to the `=`.
 * Undefined for a static field or when no declaration fits.
 */
function fieldBefore(masked: string, bodyOpen: number, depths: Int32Array, eq: number): { start: number; name: string } | undefined {
  for (let p = eq - 1; p > bodyOpen; p--) {
    if (depths[p - bodyOpen - 1] !== 0) continue;
    const before = masked[p - 1]!;
    const hard = p - 1 === bodyOpen || before === ';' || before === '}';
    if (!hard && before !== '\n') continue;
    const head = MEMBER_HEAD.exec(masked.slice(p, eq));
    if (head && (head[3] === undefined || isTypeText(head[3]))) {
      if (/\bstatic\b/.test(head[1]!)) return undefined;
      return { start: skipSpace(masked, p), name: head[2]! };
    }
    if (hard) return undefined;
  }
  return undefined;
}

/** The `alias` option of an options object literal, if it is a string literal. */
function aliasOf(source: string, masked: string, options: Range | undefined): string | undefined {
  if (!options || masked[options.start] !== '{') return undefined;
  const alias = objectProperties(source, masked, options.start, options.end - 1).find((property) => property.key === 'alias');
  return alias?.value && stringLiteralValue(source.slice(alias.value.start, alias.value.end));
}

/** The decorators for one member, as source. */
function decoratorsFor(fn: SignalFunction, required: boolean, field: string, args: Range[], source: string, masked: string, used: Set<string>): string {
  const text = (range: Range | undefined) => (range ? source.slice(range.start, range.end) : undefined);
  const query = QUERY_DECORATORS[fn];
  if (query) {
    used.add(query);
    const options = args[1] ? `...${text(args[1])}, ` : '';
    return `@${local(query)}(${text(args[0]) ?? 'undefined'}, { ${options}isSignal: true } as any) `;
  }
  if (fn === 'output' || fn === 'outputFromObservable') {
    used.add('Output');
    const alias = aliasOf(source, masked, fn === 'output' ? args[0] : args[1]) ?? field;
    return `@${local('Output')}(${JSON.stringify(alias)}) `;
  }
  // input / model: `.required(opts)` takes options first, `(initial, opts)` second.
  const alias = aliasOf(source, masked, required ? args[0] : args[1]) ?? field;
  used.add('Input');
  const config = `isSignal: true, alias: ${JSON.stringify(alias)}, required: ${required}`;
  if (fn === 'input') return `@${local('Input')}({ ${config}, transform: undefined } as any) `;
  used.add('Output');
  return `@${local('Input')}({ ${config} } as any) @${local('Output')}(${JSON.stringify(`${alias}Change`)}) `;
}

/** How this file spells each signal function it imported from Angular, as one regex alternative. */
function signalSpellings(imports: ScannedSource['imports']) {
  const all = SIGNAL_MODULES.map(({ module, functions }) => spellingsOf(valuesFrom(imports, module), functions)).filter((s) => s !== undefined);
  if (!all.length) return undefined;
  return {
    source: all.map((s) => s.source).join('|'),
    nameOf: (spelling: string) => all.map((s) => s.nameOf(spelling)).find((name) => name !== undefined) as SignalFunction | undefined,
  };
}

/** The edits decorating every signal member (see {@link ScannedSource}). */
export function signalMemberEdits({ source, masked, imports }: ScannedSource): Edit[] {
  const edits: Edit[] = [];
  const spellings = signalSpellings(imports);
  if (!spellings) return edits;
  // An assignment `=` (not `==`, `=>`, `<=`, `+=`, …) followed by a signal function call.
  const initializer = new RegExp(String.raw`(?<![=!<>+\-*/%&|^?])=(?![=>])\s*(${spellings.source})(\s*\.\s*required)?\s*(?=[<(])`, 'g');
  const used = new Set<string>();

  for (const cls of findDecoratedClasses(masked, ['Component', 'Directive'])) {
    const depths = bracketDepths(masked, cls.bodyOpen + 1, cls.bodyClose);
    for (const m of matchesAtDepthZero(masked, cls.bodyOpen + 1, cls.bodyClose, initializer)) {
      const fn = spellings.nameOf(m[1]!);
      const field = fn && fieldBefore(masked, cls.bodyOpen, depths, m.index);
      if (!fn || !field) continue;
      let open = skipSpace(masked, m.index + m[0].length);
      if (masked[open] === '<') open = skipSpace(masked, matchBracket(masked, open) + 1);
      if (masked[open] !== '(') continue;
      const close = matchBracket(masked, open);
      const args = splitTopLevel(masked, open + 1, close).map((range) => trimRange(masked, range));
      edits.push({ start: field.start, end: field.start, text: decoratorsFor(fn, !!m[2], field.name, args, source, masked, used) });
    }
  }
  if (!edits.length) return edits;
  const names = [...used].sort().map((name) => `${name} as ${local(name)}`).join(', ');
  // On the first line, so line numbers (and stack traces) stay put.
  edits.push({ start: 0, end: 0, text: `import { ${names} } from '@angular/core';` });
  return edits;
}

export function addSignalMemberDecorators(source: string): string {
  const edits = signalMemberEdits(scanSource(source));
  return edits.length ? applyEdits(source, edits) : source;
}
