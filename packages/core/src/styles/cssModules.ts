import { contentHash } from '../hash.js';

/**
 * CSS Modules for the dev server: every class and keyframes name a `.module.*`
 * stylesheet defines is renamed to one unique to that file, so two components'
 * `.title` never collide in the preview, exactly as they don't in a build (where
 * esbuild's `local-css` loader does the same job).
 *
 * Supported: `:global(.x)` / `:local(.x)` and the bare `:global` / `:local`
 * modes, `composes: a b`, `composes: a from './other.module.css'`,
 * `composes: a from global`, local `@keyframes` and the `animation` /
 * `animation-name` declarations that use them, nested rules and at-rules.
 * Names are a pure function of (file, name), so an edit never renames a class
 * an open page already holds.
 */
export type ComposedClass = { kind: 'local'; name: string } | { kind: 'global'; name: string } | { kind: 'import'; from: string; name: string };

export interface ScopedCssModule {
  css: string;
  /** Exported name (class or keyframes) → its name in `css`. */
  locals: Record<string, string>;
  /** The classes `composes:` adds to an exported class, in order. */
  composes: Record<string, ComposedClass[]>;
}

type FrameKind = 'rules' | 'decls' | 'keyframes' | 'atdecls';
interface Frame {
  kind: FrameKind;
  /** The local classes a style rule's selector names — what its `composes:` applies to. */
  classes: string[];
}

/** At-rules whose block holds rules (or, nested in a style rule, declarations). */
const GROUP_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document', '-moz-document', 'scope', 'starting-style']);
const IDENT = /^-?(?:[_a-zA-Z -￿]|\\.)(?:[\w -￿-]|\\.)*/;

/** Index just past the string starting at `at`. */
function stringEnd(text: string, at: number): number {
  const quote = text[at];
  let i = at + 1;
  while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
  return Math.min(i + 1, text.length);
}

/** Index just past the `)` matching the `(` at `at`, skipping strings and nested parens. */
function parenEnd(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") i = stringEnd(text, i) - 1;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

const unescape = (name: string) => name.replace(/\\(.)/g, '$1');

export function scopeCssModule(source: string, path: string): ScopedCssModule {
  const hash = contentHash(path, 5);
  const locals: Record<string, string> = {};
  const composes: Record<string, ComposedClass[]> = {};
  const local = (name: string): string => (locals[name] ??= `_${name.replace(/[^\w-]/g, '_')}_${hash}`);

  const keyframes = new Set<string>();
  for (const match of source.matchAll(/@(?:-[a-z]+-)?keyframes\s+(-?[_a-zA-Z][\w-]*)/g)) keyframes.add(match[1]!);

  function scopeSelector(selector: string, classes: string[]): string {
    let out = '';
    let global = false;
    for (let i = 0; i < selector.length; ) {
      const ch = selector[i]!;
      if (ch === '"' || ch === "'") {
        const end = stringEnd(selector, i);
        out += selector.slice(i, end);
        i = end;
      } else if (ch === '[') {
        const end = selector.indexOf(']', i);
        const stop = end < 0 ? selector.length : end + 1;
        out += selector.slice(i, stop);
        i = stop;
      } else if (ch === ',') {
        global = false;
        out += ch;
        i++;
      } else if (selector.startsWith(':global(', i) || selector.startsWith(':local(', i)) {
        const isGlobal = selector.startsWith(':global(', i);
        const open = i + (isGlobal ? 7 : 6);
        const close = parenEnd(selector, open);
        const inner = selector.slice(open + 1, close - 1);
        out += isGlobal ? inner : scopeSelector(inner, classes);
        i = close;
      } else if (/^:(global|local)(?![\w-])/.test(selector.slice(i))) {
        global = selector.startsWith(':global', i);
        i += global ? 7 : 6;
        if (selector[i] === ' ' && /(^|[\s>+~(,])$/.test(out)) i++; // `:global .x` → `.x`, not ` .x`
      } else if (ch === '.' && IDENT.test(selector.slice(i + 1))) {
        const raw = IDENT.exec(selector.slice(i + 1))![0];
        const name = unescape(raw);
        if (global) out += `.${raw}`;
        else {
          out += `.${local(name)}`;
          classes.push(name);
        }
        i += 1 + raw.length;
      } else {
        out += ch;
        i++;
      }
    }
    return out;
  }

  function scopeKeyframesPrelude(prelude: string): string {
    return prelude.replace(/(keyframes\s+)(?::global\(\s*([\w-]+)\s*\)|:local\(\s*([\w-]+)\s*\)|(-?[_a-zA-Z][\w-]*))/, (_m, lead: string, globalName?: string, localName?: string, plain?: string) =>
      lead + (globalName ?? local((localName ?? plain)!)),
    );
  }

  function composeDeclaration(value: string, classes: string[]): void {
    const match = /^(.*?)(?:\s+from\s+(global|"[^"]*"|'[^']*'))?\s*$/s.exec(value.trim());
    if (!match) return;
    const names = match[1]!.split(/\s+/).filter(Boolean);
    const from = match[2];
    const parts = names.map((name): ComposedClass => {
      if (from === 'global') return { kind: 'global', name };
      if (from) return { kind: 'import', from: from.slice(1, -1), name };
      local(name); // a composed local class is exported even if no selector names it
      return { kind: 'local', name };
    });
    for (const owner of classes) (composes[owner] ??= []).push(...parts);
  }

  const stack: Frame[] = [{ kind: 'rules', classes: [] }];
  const top = () => stack[stack.length - 1]!;
  let out = '';

  function statement(text: string): void {
    const frame = top();
    if (frame.kind === 'decls') {
      const composed = /^\s*composes\s*:\s*([^;]*);?\s*$/is.exec(text);
      if (composed) return composeDeclaration(composed[1]!, frame.classes);
      const animation = /^(\s*(?:-[a-z]+-)?animation(?:-name)?\s*:)([^;]*)(;?\s*)$/is.exec(text);
      if (animation) {
        const value = animation[2]!.replace(/(^|[\s,])(-?[_a-zA-Z][\w-]*)(?=$|[\s,])/g, (m, lead: string, name: string) => (keyframes.has(name) ? lead + local(name) : m));
        out += animation[1] + value + animation[3];
        return;
      }
    }
    out += text;
  }

  function open(prelude: string): void {
    const parent = top();
    const trimmed = prelude.trim();
    if (trimmed.startsWith('@')) {
      const name = (/^@([\w-]+)/.exec(trimmed)?.[1] ?? '').toLowerCase();
      if (name.endsWith('keyframes')) {
        out += `${scopeKeyframesPrelude(prelude)}{`;
        stack.push({ kind: 'keyframes', classes: [] });
      } else {
        out += `${prelude}{`;
        stack.push({ kind: GROUP_AT_RULES.has(name) ? (parent.kind === 'decls' ? 'decls' : 'rules') : 'atdecls', classes: parent.classes });
      }
    } else if (parent.kind === 'keyframes' || parent.kind === 'atdecls') {
      out += `${prelude}{`;
      stack.push({ kind: 'atdecls', classes: [] });
    } else {
      const classes: string[] = [];
      out += `${scopeSelector(prelude, classes)}{`;
      stack.push({ kind: 'decls', classes });
    }
  }

  let buffer = '';
  for (let i = 0; i < source.length; ) {
    const ch = source[i]!;
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2; // comments are dropped from the dev stylesheet
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(source, i);
      buffer += source.slice(i, end);
      i = end;
    } else if (ch === '(') {
      // `url(data:…;…)` and `:not(.a, .b)` hold characters that would otherwise end a statement.
      const end = parenEnd(source, i);
      buffer += source.slice(i, end);
      i = end;
    } else if (ch === '{') {
      open(buffer);
      buffer = '';
      i++;
    } else if (ch === ';') {
      statement(`${buffer};`);
      buffer = '';
      i++;
    } else if (ch === '}') {
      if (buffer.trim()) statement(buffer);
      buffer = '';
      out += '}';
      if (stack.length > 1) stack.pop();
      i++;
    } else {
      buffer += ch;
      i++;
    }
  }
  out += buffer;
  return { css: out, locals, composes };
}

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await arguments eval'.split(' '),
);

/**
 * The JS module a dev-server CSS Module becomes: it injects its scoped CSS via
 * `injectCss` (a statement given the CSS literal), and exports the class map as
 * the default plus each valid identifier as a named export — Vite's shape.
 * `importUrl` maps a `composes … from` path to the URL its module is served at.
 */
export function cssModuleToModule(scoped: ScopedCssModule, path: string, injectCss: (cssExpression: string) => string, importUrl: (from: string) => string | undefined): string {
  const imports = new Map<string, string>();
  const importName = (from: string) => {
    let name = imports.get(from);
    if (!name) imports.set(from, (name = `__composed${imports.size}`));
    return name;
  };

  const valueOf = (key: string, seen: Set<string>): string[] => {
    if (seen.has(key)) return [];
    seen.add(key);
    const parts = [JSON.stringify(scoped.locals[key] ?? key)];
    for (const part of scoped.composes[key] ?? []) {
      if (part.kind === 'local') parts.push(...valueOf(part.name, seen));
      else if (part.kind === 'global') parts.push(JSON.stringify(part.name));
      else parts.push(`${importName(part.from)}[${JSON.stringify(part.name)}]`);
    }
    return parts;
  };

  const entries = Object.keys(scoped.locals).map((key) => `  ${JSON.stringify(key)}: ${valueOf(key, new Set()).join(' + " " + ')},`);
  const header: string[] = [];
  for (const [from, name] of imports) {
    const url = importUrl(from);
    if (!url) throw new Error(`${path}: cannot find "${from}" (composes … from)`);
    header.push(`import ${name} from ${JSON.stringify(url)};`);
  }
  const named = Object.keys(scoped.locals)
    .filter((key) => /^[A-Za-z_$][\w$]*$/.test(key) && !RESERVED.has(key))
    .map((key) => `export const ${key} = __classes[${JSON.stringify(key)}];`);
  return [...header, injectCss(JSON.stringify(scoped.css)), `const __classes = {\n${entries.join('\n')}\n};`, 'export default __classes;', ...named].join('\n');
}
