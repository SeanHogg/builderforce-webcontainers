import { applyEdits, findDecoratedClasses, maskCode, matchBracket, matchesAtDepthZero, objectProperties, skipSpace, splitTopLevel, stringLiteralValue, trimRange, type Edit, type Range } from './scanner.js';

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
 * The decorators are imported once, under names no source would use.
 */

const FUNCTIONS = ['input', 'model', 'output', 'outputFromObservable', 'viewChild', 'viewChildren', 'contentChild', 'contentChildren'] as const;
type SignalFunction = (typeof FUNCTIONS)[number];

const QUERY_DECORATORS: Partial<Record<SignalFunction, string>> = {
  viewChild: 'ViewChild',
  viewChildren: 'ViewChildren',
  contentChild: 'ContentChild',
  contentChildren: 'ContentChildren',
};

/** `ɵɵngJit<Name>` — the local name each decorator is imported under. */
const local = (decorator: string) => `ɵɵngJit${decorator}`;

const MEMBER = new RegExp(
  String.raw`((?:(?:public|private|protected|readonly|override)\s+)*)([A-Za-z_$][\w$]*)\s*[?!]?\s*(?::[^=;{}]*(?:=>[^=;{}]*)*)?=\s*(${FUNCTIONS.join('|')})(\.required)?\s*(?=[<(])`,
  'g',
);

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

export function addSignalMemberDecorators(source: string): string {
  if (!/\b(input|model|output|outputFromObservable|viewChild|viewChildren|contentChild|contentChildren)\b/.test(source)) return source;
  const masked = maskCode(source);
  const edits: Edit[] = [];
  const used = new Set<string>();

  for (const cls of findDecoratedClasses(masked, ['Component', 'Directive'])) {
    for (const m of matchesAtDepthZero(masked, cls.bodyOpen + 1, cls.bodyClose, MEMBER)) {
      // A member starts a statement: after `{`, `;`, `}` or a line break — and is not `static`.
      let before = m.index - 1;
      while (before > cls.bodyOpen && /[ \t]/.test(masked[before]!)) before--;
      if (!/[{};\n\r]/.test(masked[before]!) && before !== cls.bodyOpen) continue;
      let open = skipSpace(masked, m.index + m[0].length);
      if (masked[open] === '<') open = skipSpace(masked, matchBracket(masked, open) + 1);
      if (masked[open] !== '(') continue;
      const close = matchBracket(masked, open);
      const args = splitTopLevel(masked, open + 1, close).map((range) => trimRange(masked, range));
      const fn = m[3] as SignalFunction;
      const text = decoratorsFor(fn, !!m[4], m[2]!, args, source, masked, used);
      edits.push({ start: m.index, end: m.index, text });
    }
  }
  if (!edits.length) return source;
  const imports = [...used].sort().map((name) => `${name} as ${local(name)}`).join(', ');
  // On the first line, so line numbers (and stack traces) stay put.
  edits.push({ start: 0, end: 0, text: `import { ${imports} } from '@angular/core';` });
  return applyEdits(source, edits);
}
